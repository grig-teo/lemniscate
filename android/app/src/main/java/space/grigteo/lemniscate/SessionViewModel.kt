package space.grigteo.lemniscate

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import retrofit2.HttpException
import space.grigteo.lemniscate.core.api.LemniscateApi

sealed interface SessionState {
    data object Loading : SessionState
    data object LoggedOut : SessionState
    data object LoggedIn : SessionState
}

/** Decides at launch (and after login) whether to show Auth or Main. */
class SessionViewModel(
    private val api: LemniscateApi,
    private val token: Flow<String?>,
    private val clearSessionToken: () -> Unit,
) : ViewModel() {

    private val _state = MutableStateFlow<SessionState>(SessionState.Loading)
    val state: StateFlow<SessionState> = _state.asStateFlow()

    init {
        viewModelScope.launch { checkExistingSession() }
    }

    private suspend fun checkExistingSession() {
        if (token.first() == null) {
            _state.value = SessionState.LoggedOut
            return
        }
        try {
            api.me()
            _state.value = SessionState.LoggedIn
        } catch (e: HttpException) {
            if (e.code() == 401) clearSessionToken()
            _state.value = SessionState.LoggedOut
        } catch (e: Exception) {
            // Network down etc.: keep the stored cookie, let the user retry.
            _state.value = SessionState.LoggedOut
        }
    }

    fun onLoggedIn() {
        _state.value = SessionState.LoggedIn
    }

    companion object {
        fun factory(app: LemniscateApp) = viewModelFactory {
            initializer {
                SessionViewModel(app.api, app.sessionStore.token) { app.cookieJar.setToken(null) }
            }
        }
    }
}
