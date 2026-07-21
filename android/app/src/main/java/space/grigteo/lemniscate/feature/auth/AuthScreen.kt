package space.grigteo.lemniscate.feature.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import space.grigteo.lemniscate.LemniscateApp
import space.grigteo.lemniscate.core.Env
import space.grigteo.lemniscate.core.Providers
import space.grigteo.lemniscate.core.api.LemniscateApi

private enum class AuthDialog { NONE, GITHUB, GITLAB, GITVERSE }

/** Login screen: OAuth via WebView (GitHub/GitLab) or a GitVerse access token. */
@Composable
fun AuthScreen(onLoggedIn: () -> Unit) {
    val app = LocalContext.current.applicationContext as LemniscateApp
    val viewModel: AuthViewModel = viewModel(factory = AuthViewModel.factory(app))
    var dialog by remember { mutableStateOf(AuthDialog.NONE) }

    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Lemniscate", style = MaterialTheme.typography.headlineLarge)
        Spacer(Modifier.height(8.dp))
        Text(
            "Sign in to create tasks with your voice",
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(32.dp))
        ConnectButton("Continue with GitHub", viewModel.busy) { dialog = AuthDialog.GITHUB }
        Spacer(Modifier.height(12.dp))
        ConnectButton("Continue with GitLab", viewModel.busy) { dialog = AuthDialog.GITLAB }
        Spacer(Modifier.height(12.dp))
        OutlinedButton(
            onClick = { dialog = AuthDialog.GITVERSE },
            enabled = !viewModel.busy,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Connect GitVerse with a token") }
        viewModel.error?.let {
            Spacer(Modifier.height(16.dp))
            Text(it, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
        }
    }

    AuthDialogs(dialog, viewModel, onLoggedIn) { dialog = AuthDialog.NONE }
}

@Composable
private fun ConnectButton(label: String, busy: Boolean, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
        Text(label)
    }
}

@Composable
private fun AuthDialogs(
    dialog: AuthDialog,
    viewModel: AuthViewModel,
    onLoggedIn: () -> Unit,
    close: () -> Unit,
) {
    val oauthProvider = when (dialog) {
        AuthDialog.GITHUB -> Providers.GITHUB
        AuthDialog.GITLAB -> Providers.GITLAB
        else -> null
    }
    if (oauthProvider != null) {
        OAuthWebViewDialog(
            url = LemniscateApi.oauthUrl(Env.serverUrl, oauthProvider),
            title = "Sign in with ${Providers.label(oauthProvider)}",
            onAuthenticated = { token ->
                close()
                viewModel.completeOAuth(token, onLoggedIn)
            },
            onDismiss = close,
        )
    }
    if (dialog == AuthDialog.GITVERSE) {
        GitVerseTokenDialog(
            busy = viewModel.busy,
            onConnect = { token, baseUrl ->
                viewModel.connectWithToken(Providers.GITVERSE, token, baseUrl, onLoggedIn)
            },
            onDismiss = close,
        )
    }
}
