package space.grigteo.lemniscate.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import space.grigteo.lemniscate.LemniscateApp
import space.grigteo.lemniscate.core.Env
import space.grigteo.lemniscate.core.Providers
import space.grigteo.lemniscate.core.api.LemniscateApi
import space.grigteo.lemniscate.core.api.LlmConfigDto
import space.grigteo.lemniscate.feature.auth.GitVerseTokenDialog
import space.grigteo.lemniscate.feature.auth.OAuthWebViewDialog

private enum class ConnectDialog { NONE, GITHUB, GITLAB, GITVERSE }

/** Settings dialog with "Git connections" and "LLM configs" tabs. */
@Composable
fun SettingsDialog(onDismiss: () -> Unit) {
    val app = LocalContext.current.applicationContext as LemniscateApp
    val viewModel: SettingsViewModel = viewModel(factory = SettingsViewModel.factory(app))
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val snackbarHost = remember { SnackbarHostState() }
    var tab by remember { mutableIntStateOf(0) }

    LaunchedEffect(ui.snackbar) {
        ui.snackbar?.let {
            snackbarHost.showSnackbar(it)
            viewModel.dismissSnackbar()
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(modifier = Modifier.fillMaxSize()) {
            Scaffold(snackbarHost = { SnackbarHost(snackbarHost) }) { padding ->
                Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
                    SettingsHeader(onDismiss)
                    TabRow(selectedTabIndex = tab) {
                        Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Git connections") })
                        Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("LLM configs") })
                    }
                    if (ui.loading) {
                        CircularProgressIndicator(
                            modifier = Modifier.align(Alignment.CenterHorizontally).padding(32.dp),
                        )
                    } else if (tab == 0) {
                        ConnectionsTab(ui, viewModel)
                    } else {
                        LlmConfigsTab(ui, viewModel)
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsHeader(onDismiss: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Settings", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
        IconButton(onClick = onDismiss) {
            Icon(Icons.Default.Close, contentDescription = "Close")
        }
    }
}

@Composable
private fun ConnectionsTab(ui: SettingsUiState, viewModel: SettingsViewModel) {
    var connectDialog by remember { mutableStateOf(ConnectDialog.NONE) }

    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(ui.connections, key = { it.id }) { connection ->
            ConnectionRow(connection, ui.busy, viewModel)
        }
        item {
            Text(
                "Connect a git host",
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(top = 24.dp, bottom = 8.dp),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { connectDialog = ConnectDialog.GITHUB }, enabled = !ui.busy) {
                    Text("GitHub")
                }
                OutlinedButton(onClick = { connectDialog = ConnectDialog.GITLAB }, enabled = !ui.busy) {
                    Text("GitLab")
                }
                OutlinedButton(onClick = { connectDialog = ConnectDialog.GITVERSE }, enabled = !ui.busy) {
                    Text("GitVerse")
                }
            }
        }
    }

    ConnectDialogs(connectDialog, ui.busy, viewModel) { connectDialog = ConnectDialog.NONE }
}

@Composable
private fun ConnectionRow(
    connection: space.grigteo.lemniscate.core.api.ConnectionDto,
    busy: Boolean,
    viewModel: SettingsViewModel,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text("${Providers.label(connection.provider)}  ·  @${connection.username}")
            connection.baseUrl?.let {
                Text(it, style = MaterialTheme.typography.bodySmall)
            }
            connection._count?.let {
                Text("${it.repositories} repositories", style = MaterialTheme.typography.bodySmall)
            }
        }
        TextButton(onClick = { viewModel.sync(connection.id) }, enabled = !busy) { Text("Sync") }
        TextButton(onClick = { viewModel.disconnect(connection.id) }, enabled = !busy) {
            Text("Disconnect", color = MaterialTheme.colorScheme.error)
        }
    }
    HorizontalDivider()
}

@Composable
private fun ConnectDialogs(dialog: ConnectDialog, busy: Boolean, viewModel: SettingsViewModel, close: () -> Unit) {
    val oauthProvider = when (dialog) {
        ConnectDialog.GITHUB -> Providers.GITHUB
        ConnectDialog.GITLAB -> Providers.GITLAB
        else -> null
    }
    if (oauthProvider != null) {
        OAuthWebViewDialog(
            url = LemniscateApi.oauthUrl(Env.serverUrl, oauthProvider),
            title = "Connect ${Providers.label(oauthProvider)}",
            sessionToken = viewModel.currentSessionToken,
            onAuthenticated = {
                close()
                viewModel.refresh()
            },
            onDismiss = close,
        )
    }
    if (dialog == ConnectDialog.GITVERSE) {
        GitVerseTokenDialog(
            busy = busy,
            onConnect = { token, baseUrl ->
                viewModel.connectWithToken(Providers.GITVERSE, token, baseUrl, onDone = close)
            },
            onDismiss = close,
        )
    }
}

@Composable
private fun LlmConfigsTab(ui: SettingsUiState, viewModel: SettingsViewModel) {
    var editing by remember { mutableStateOf<LlmConfigDto?>(null) }
    var adding by remember { mutableStateOf(false) }

    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(ui.llmConfigs, key = { it.id }) { config ->
            LlmConfigRow(config, ui.busy, onEdit = { editing = config }, onDelete = { viewModel.deleteLlmConfig(config.id) })
        }
        item {
            TextButton(onClick = { adding = true }, enabled = !ui.busy) {
                Icon(Icons.Default.Add, contentDescription = null)
                Text("Add config")
            }
        }
    }

    if (adding || editing != null) {
        LlmConfigFormDialog(
            initial = editing,
            busy = ui.busy,
            onSave = { payload ->
                viewModel.saveLlmConfig(editing, payload) {
                    adding = false
                    editing = null
                }
            },
            onTest = viewModel::testLlmConfig,
            onDismiss = { adding = false; editing = null },
        )
    }
}

@Composable
private fun LlmConfigRow(
    config: LlmConfigDto,
    busy: Boolean,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(config.name + if (config.isDefault) "  (default)" else "")
            Text(config.model, style = MaterialTheme.typography.bodySmall)
            if (!config.enabled) {
                Text("disabled", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
        }
        TextButton(onClick = onEdit, enabled = !busy) { Text("Edit") }
        TextButton(onClick = onDelete, enabled = !busy) {
            Text("Delete", color = MaterialTheme.colorScheme.error)
        }
    }
    HorizontalDivider()
}
