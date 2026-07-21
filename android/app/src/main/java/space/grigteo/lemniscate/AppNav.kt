package space.grigteo.lemniscate

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import space.grigteo.lemniscate.feature.auth.AuthScreen
import space.grigteo.lemniscate.feature.main.MainScreen

/** Top-level switch between the auth flow and the main screen. */
@Composable
fun AppNav() {
    val app = LocalContext.current.applicationContext as LemniscateApp
    val viewModel: SessionViewModel = viewModel(factory = SessionViewModel.factory(app))
    val state by viewModel.state.collectAsStateWithLifecycle()

    Surface(modifier = Modifier.fillMaxSize()) {
        when (state) {
            SessionState.Loading -> LoadingPane()
            SessionState.LoggedOut -> AuthScreen(onLoggedIn = viewModel::onLoggedIn)
            SessionState.LoggedIn -> MainScreen()
        }
    }
}

@Composable
private fun LoadingPane() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}
