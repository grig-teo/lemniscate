package space.grigteo.lemniscate.feature.auth

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.launch
import space.grigteo.lemniscate.LemniscateApp
import space.grigteo.lemniscate.core.Providers
import space.grigteo.lemniscate.core.api.ConnectionPayload
import space.grigteo.lemniscate.core.api.friendlyMessage

/** Handles token-based provider login; OAuth logins report through [completeOAuth]. */
class AuthViewModel(private val app: LemniscateApp) : ViewModel() {

    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    /** Store the session cookie harvested from the OAuth WebView. */
    fun completeOAuth(token: String, onLoggedIn: () -> Unit) {
        app.cookieJar.setToken(token)
        onLoggedIn()
    }

    /** GitVerse (or PAT) login: POST /api/connections sets the session cookie. */
    fun connectWithToken(provider: String, token: String, baseUrl: String?, onLoggedIn: () -> Unit) {
        if (busy) return
        busy = true
        error = null
        viewModelScope.launch {
            try {
                app.api.connect(ConnectionPayload(provider, token.trim(), baseUrl?.trim()?.ifBlank { null }))
                onLoggedIn()
            } catch (e: Exception) {
                error = e.friendlyMessage()
            } finally {
                busy = false
            }
        }
    }

    companion object {
        val DEFAULT_GITVERSE_URL = "https://gitverse.ru"

        fun factory(app: LemniscateApp) = viewModelFactory {
            initializer { AuthViewModel(app) }
        }
    }
}
