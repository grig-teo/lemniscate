package space.grigteo.lemniscate.testing

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import space.grigteo.lemniscate.core.api.ConnectionDto
import space.grigteo.lemniscate.core.api.ConnectionPayload
import space.grigteo.lemniscate.core.api.ConnectionsResponse
import space.grigteo.lemniscate.core.api.CreateTaskBody
import space.grigteo.lemniscate.core.api.LemniscateApi
import space.grigteo.lemniscate.core.api.LlmConfigDto
import space.grigteo.lemniscate.core.api.LlmConfigPayload
import space.grigteo.lemniscate.core.api.LlmConfigsResponse
import space.grigteo.lemniscate.core.api.LlmTestResult
import space.grigteo.lemniscate.core.api.MeResponse
import space.grigteo.lemniscate.core.api.RepoSelectionStore
import space.grigteo.lemniscate.core.api.RepositoriesResponse
import space.grigteo.lemniscate.core.api.TaskResponse
import space.grigteo.lemniscate.core.api.TasksResponse

/**
 * Programmable fake of the Retrofit API. Only stub the methods a test
 * exercises; calling an unstubbed method fails fast with a clear message.
 */
class FakeLemniscateApi : LemniscateApi {
    var meResult: suspend () -> MeResponse = { error("me() not stubbed") }
    var connectionsResult: suspend () -> ConnectionsResponse = { error("connections() not stubbed") }
    var repositoriesResult: suspend () -> RepositoriesResponse = { error("repositories() not stubbed") }
    var tasksResult: suspend (String) -> TasksResponse = { error("tasks() not stubbed") }
    var llmConfigsResult: suspend () -> LlmConfigsResponse = { error("llmConfigs() not stubbed") }
    var testLlmConfigResult: suspend (LlmConfigPayload) -> LlmTestResult = { error("testLlmConfig() not stubbed") }
    var testSavedLlmConfigResult: suspend (String) -> LlmTestResult = { error("testSavedLlmConfig() not stubbed") }

    val createdTasks = mutableListOf<CreateTaskBody>()
    var createTaskError: Throwable? = null

    val connectCalls = mutableListOf<ConnectionPayload>()
    var connectError: Throwable? = null

    val disconnectedIds = mutableListOf<String>()
    var disconnectError: Throwable? = null

    val deletedLlmConfigIds = mutableListOf<String>()

    override suspend fun me(): MeResponse = meResult()

    override suspend fun connections(): ConnectionsResponse = connectionsResult()

    override suspend fun connect(body: ConnectionPayload): ConnectionDto {
        connectError?.let { throw it }
        connectCalls += body
        return ConnectionDto(id = "conn_${connectCalls.size}", provider = body.provider, username = "octocat")
    }

    override suspend fun disconnect(id: String) {
        disconnectError?.let { throw it }
        disconnectedIds += id
    }

    override suspend fun syncConnection(id: String) = Unit

    override suspend fun repositories(): RepositoriesResponse = repositoriesResult()

    override suspend fun tasks(repositoryId: String): TasksResponse = tasksResult(repositoryId)

    override suspend fun createTask(body: CreateTaskBody): TaskResponse {
        createTaskError?.let { throw it }
        createdTasks += body
        return TaskResponse(
            space.grigteo.lemniscate.core.api.TaskDto(
                id = "task_${createdTasks.size}",
                repositoryId = body.repositoryId,
                prompt = body.prompt,
                status = "queued",
            ),
        )
    }

    override suspend fun llmConfigs(): LlmConfigsResponse = llmConfigsResult()

    override suspend fun createLlmConfig(body: LlmConfigPayload): LlmConfigDto =
        error("createLlmConfig() not stubbed")

    override suspend fun updateLlmConfig(id: String, body: LlmConfigPayload): LlmConfigDto =
        error("updateLlmConfig() not stubbed")

    override suspend fun deleteLlmConfig(id: String) {
        deletedLlmConfigIds += id
    }

    override suspend fun testLlmConfig(body: LlmConfigPayload): LlmTestResult = testLlmConfigResult(body)

    override suspend fun testSavedLlmConfig(id: String): LlmTestResult = testSavedLlmConfigResult(id)
}

/** In-memory [RepoSelectionStore] with observable saves. */
class FakeRepoSelectionStore(initialId: String? = null) : RepoSelectionStore {
    private val saved = MutableStateFlow(initialId)
    override val selectedRepoId: Flow<String?> = saved

    override suspend fun saveSelectedRepoId(id: String?) {
        saved.value = id
    }
}
