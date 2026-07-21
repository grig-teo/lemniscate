package space.grigteo.lemniscate.feature.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import space.grigteo.lemniscate.LemniscateApp
import space.grigteo.lemniscate.core.ConnectionGroup
import space.grigteo.lemniscate.core.api.CreateTaskBody
import space.grigteo.lemniscate.core.api.RepositoryDto
import space.grigteo.lemniscate.core.api.TaskDto
import space.grigteo.lemniscate.core.api.friendlyMessage
import space.grigteo.lemniscate.core.groupByConnection

data class MainUiState(
    val loading: Boolean = true,
    val groups: List<ConnectionGroup> = emptyList(),
    val selectedRepo: RepositoryDto? = null,
    val recording: Boolean = false,
    val sending: Boolean = false,
    val committedTranscript: String = "",
    val partialTranscript: String = "",
    val runningTasks: Map<String, List<TaskDto>> = emptyMap(),
    val snackbar: String? = null,
) {
    val transcript: String
        get() = listOf(committedTranscript, partialTranscript)
            .filter { it.isNotBlank() }
            .joinToString(" ")
}

/** State and actions for the main voice-prompt screen. */
class MainViewModel(private val app: LemniscateApp) : ViewModel() {

    private val _ui = MutableStateFlow(MainUiState())
    val ui: StateFlow<MainUiState> = _ui.asStateFlow()

    init {
        viewModelScope.launch { loadRepositories() }
    }

    suspend fun loadRepositories() {
        _ui.update { it.copy(loading = true) }
        try {
            val repos = app.api.repositories().repositories
            val restored = restoreSelection(repos)
            _ui.update {
                it.copy(
                    loading = false,
                    groups = groupByConnection(repos),
                    selectedRepo = restored ?: it.selectedRepo?.let { sel -> repos.find { r -> r.id == sel.id } },
                )
            }
        } catch (e: Exception) {
            _ui.update { it.copy(loading = false, snackbar = e.friendlyMessage()) }
        }
    }

    private suspend fun restoreSelection(repos: List<RepositoryDto>): RepositoryDto? {
        val savedId = app.sessionStore.selectedRepoId.first() ?: return null
        return repos.find { it.id == savedId }
    }

    fun selectRepo(repo: RepositoryDto) {
        _ui.update { it.copy(selectedRepo = repo) }
        viewModelScope.launch { app.sessionStore.saveSelectedRepoId(repo.id) }
    }

    fun setRecording(recording: Boolean) {
        _ui.update { it.copy(recording = recording, partialTranscript = "") }
    }

    fun onPartialTranscript(text: String) {
        _ui.update { it.copy(partialTranscript = text) }
    }

    fun onFinalTranscript(text: String) {
        _ui.update {
            it.copy(
                committedTranscript = listOf(it.committedTranscript, text)
                    .filter { s -> s.isNotBlank() }
                    .joinToString(" "),
                partialTranscript = "",
            )
        }
    }

    fun editTranscript(text: String) {
        _ui.update { it.copy(committedTranscript = text, partialTranscript = "") }
    }

    /** Send the current transcript as a task prompt for the selected repo. */
    fun submitPrompt() {
        val state = _ui.value
        val repo = state.selectedRepo ?: return
        val prompt = state.transcript.trim()
        if (state.sending || prompt.isBlank()) return
        _ui.update { it.copy(sending = true) }
        viewModelScope.launch {
            try {
                app.api.createTask(CreateTaskBody(repo.id, prompt))
                _ui.update { it.copy(sending = false, committedTranscript = "", partialTranscript = "") }
            } catch (e: Exception) {
                _ui.update { it.copy(sending = false, snackbar = e.friendlyMessage()) }
            }
        }
    }

    /** Load running (queued|running) tasks for one repository, for the picker. */
    fun loadRunningTasks(repoId: String) {
        viewModelScope.launch {
            try {
                val running = app.api.tasks(repoId).tasks.filter { it.isRunning }
                _ui.update { it.copy(runningTasks = it.runningTasks + (repoId to running)) }
            } catch (e: Exception) {
                _ui.update { it.copy(snackbar = e.friendlyMessage()) }
            }
        }
    }

    fun showError(message: String) {
        _ui.update { it.copy(snackbar = message) }
    }

    fun dismissSnackbar() {
        _ui.update { it.copy(snackbar = null) }
    }

    companion object {
        fun factory(app: LemniscateApp) = viewModelFactory {
            initializer { MainViewModel(app) }
        }
    }
}
