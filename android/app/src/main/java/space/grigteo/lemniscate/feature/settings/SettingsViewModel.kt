package space.grigteo.lemniscate.feature.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import space.grigteo.lemniscate.LemniscateApp
import space.grigteo.lemniscate.core.api.ConnectionDto
import space.grigteo.lemniscate.core.api.ConnectionPayload
import space.grigteo.lemniscate.core.api.LlmConfigDto
import space.grigteo.lemniscate.core.api.LlmConfigPayload
import space.grigteo.lemniscate.core.api.LlmTestResult
import space.grigteo.lemniscate.core.api.friendlyMessage

data class SettingsUiState(
    val loading: Boolean = true,
    val connections: List<ConnectionDto> = emptyList(),
    val llmConfigs: List<LlmConfigDto> = emptyList(),
    val busy: Boolean = false,
    val snackbar: String? = null,
)

/** State and actions for the settings dialog (connections + LLM configs). */
class SettingsViewModel(private val app: LemniscateApp) : ViewModel() {

    private val _ui = MutableStateFlow(SettingsUiState())
    val ui: StateFlow<SettingsUiState> = _ui.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true) }
            try {
                val connections = async { app.api.connections().connections }
                val configs = async { app.api.llmConfigs().configs }
                _ui.update {
                    it.copy(loading = false, connections = connections.await(), llmConfigs = configs.await())
                }
            } catch (e: Exception) {
                _ui.update { it.copy(loading = false, snackbar = e.friendlyMessage()) }
            }
        }
    }

    val currentSessionToken: String? get() = app.cookieJar.currentToken

    fun connectWithToken(provider: String, token: String, baseUrl: String?, onDone: () -> Unit) {
        runBusy(onDone) {
            app.api.connect(ConnectionPayload(provider, token.trim(), baseUrl?.trim()?.ifBlank { null }))
        }
    }

    fun disconnect(id: String) = runBusy { app.api.disconnect(id) }

    fun sync(id: String) = runBusy { app.api.syncConnection(id) }

    fun saveLlmConfig(existing: LlmConfigDto?, payload: LlmConfigPayload, onDone: () -> Unit) {
        runBusy(onDone) {
            if (existing == null) app.api.createLlmConfig(payload)
            else app.api.updateLlmConfig(existing.id, payload)
        }
    }

    fun deleteLlmConfig(id: String) = runBusy { app.api.deleteLlmConfig(id) }

    /** Test an unsaved payload, or a saved config when [savedId] is given. */
    suspend fun testLlmConfig(savedId: String?, payload: LlmConfigPayload): LlmTestResult =
        try {
            if (savedId != null) app.api.testSavedLlmConfig(savedId)
            else app.api.testLlmConfig(payload)
        } catch (e: Exception) {
            LlmTestResult(ok = false, error = e.friendlyMessage())
        }

    private fun runBusy(onDone: (() -> Unit)? = null, block: suspend () -> Unit) {
        if (_ui.value.busy) return
        _ui.update { it.copy(busy = true) }
        viewModelScope.launch {
            try {
                block()
                refresh()
                onDone?.invoke()
            } catch (e: Exception) {
                _ui.update { it.copy(snackbar = e.friendlyMessage()) }
            } finally {
                _ui.update { it.copy(busy = false) }
            }
        }
    }

    fun dismissSnackbar() {
        _ui.update { it.copy(snackbar = null) }
    }

    companion object {
        fun factory(app: LemniscateApp) = viewModelFactory {
            initializer { SettingsViewModel(app) }
        }
    }
}
