package space.grigteo.lemniscate.feature.main

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import space.grigteo.lemniscate.core.ConnectionGroup
import space.grigteo.lemniscate.core.Providers
import space.grigteo.lemniscate.core.api.RepositoryDto
import space.grigteo.lemniscate.core.api.TaskDto

/** Full-screen repository picker grouped by git host connection. */
@Composable
fun RepoPickerDialog(
    ui: MainUiState,
    onLoadRunning: (String) -> Unit,
    onSelect: (RepositoryDto) -> Unit,
    onDismiss: () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(modifier = Modifier.fillMaxSize()) {
            Column(modifier = Modifier.padding(16.dp)) {
                PickerHeader(onDismiss)
                when {
                    ui.loading -> CircularProgressIndicator(
                        modifier = Modifier.align(Alignment.CenterHorizontally).padding(32.dp),
                    )
                    ui.groups.isEmpty() -> Text(
                        "No repositories yet. Connect a git host in Settings and sync it.",
                        modifier = Modifier.padding(16.dp),
                    )
                    else -> GroupList(ui, onLoadRunning, onSelect)
                }
            }
        }
    }
}

@Composable
private fun PickerHeader(onDismiss: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Repositories", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
        IconButton(onClick = onDismiss) {
            Icon(Icons.Default.Close, contentDescription = "Close")
        }
    }
    HorizontalDivider()
}

@Composable
private fun GroupList(
    ui: MainUiState,
    onLoadRunning: (String) -> Unit,
    onSelect: (RepositoryDto) -> Unit,
) {
    LazyColumn {
        ui.groups.forEach { group ->
            item(key = group.connectionId) { GroupHeader(group) }
            group.repos.forEach { repo ->
                item(key = repo.id) {
                    RepoRow(repo, ui, onLoadRunning, onSelect)
                }
            }
        }
    }
}

@Composable
private fun GroupHeader(group: ConnectionGroup) {
    Text(
        "${Providers.label(group.provider)}  ·  @${group.username}",
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = 16.dp, bottom = 4.dp),
    )
}

@Composable
private fun RepoRow(
    repo: RepositoryDto,
    ui: MainUiState,
    onLoadRunning: (String) -> Unit,
    onSelect: (RepositoryDto) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    LaunchedEffect(expanded) { if (expanded) onLoadRunning(repo.id) }

    Column {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        ) {
            Column(modifier = Modifier.weight(1f).clickable { onSelect(repo) }) {
                Text(repo.fullName, style = MaterialTheme.typography.bodyLarge)
            }
            if (repo.id == ui.selectedRepo?.id) {
                Text("Selected", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
            }
            IconButton(onClick = { expanded = !expanded }) {
                Icon(
                    if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                    contentDescription = if (expanded) "Hide tasks" else "Show running tasks",
                )
            }
        }
        if (expanded) RunningTasks(ui.runningTasks[repo.id])
        HorizontalDivider()
    }
}

@Composable
private fun RunningTasks(tasks: List<TaskDto>?) {
    when {
        tasks == null -> Text("Loading tasks…", style = MaterialTheme.typography.bodySmall)
        tasks.isEmpty() -> Text("No running tasks", style = MaterialTheme.typography.bodySmall)
        else -> Column {
            tasks.forEach { task ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(vertical = 2.dp),
                ) {
                    AssistChip(onClick = {}, label = { Text(task.status) })
                    Spacer(Modifier.padding(4.dp))
                    Text(
                        task.title ?: task.prompt?.take(60) ?: task.id,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
        }
    }
}
