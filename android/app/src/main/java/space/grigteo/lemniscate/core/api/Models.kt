package space.grigteo.lemniscate.core.api

import kotlinx.serialization.Serializable

// All DTOs for the lemniscate backend live here — the single source of truth
// for the wire format. Optional/irrelevant fields default to null so decoding
// stays tolerant of server additions.

@Serializable
data class UserDto(
    val id: String,
    val createdAt: String? = null,
    val gitConnections: List<ConnectionDto> = emptyList(),
)

@Serializable
data class MeResponse(val user: UserDto)

@Serializable
data class RepoCount(val repositories: Int = 0)

@Serializable
data class ConnectionDto(
    val id: String,
    val provider: String,
    val baseUrl: String? = null,
    val username: String,
    val _count: RepoCount? = null,
)

@Serializable
data class ConnectionsResponse(val connections: List<ConnectionDto>)

@Serializable
data class ConnectionPayload(
    val provider: String,
    val token: String,
    val baseUrl: String? = null,
)

@Serializable
data class RepoConnectionRef(val provider: String, val username: String)

@Serializable
data class RepositoryDto(
    val id: String,
    val connectionId: String,
    val externalId: String? = null,
    val name: String,
    val fullName: String,
    val cloneUrl: String? = null,
    val defaultBranch: String? = null,
    val autoPropose: Boolean? = null,
    val autoCreatePr: Boolean? = null,
    val autoReviewPr: Boolean? = null,
    val autoMergePr: Boolean? = null,
    val llmConfigId: String? = null,
    val connection: RepoConnectionRef,
)

@Serializable
data class RepositoriesResponse(val repositories: List<RepositoryDto>)

@Serializable
data class TaskDto(
    val id: String,
    val repositoryId: String,
    val kind: String? = null,
    val title: String? = null,
    val prompt: String? = null,
    val status: String,
    val branchName: String? = null,
    val prUrl: String? = null,
    val llmConfigId: String? = null,
    val thinkingLevel: String? = null,
    val error: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
) {
    val isRunning: Boolean get() = status == "queued" || status == "running"
}

@Serializable
data class TasksResponse(val tasks: List<TaskDto>)

@Serializable
data class CreateTaskBody(val repositoryId: String, val prompt: String)

@Serializable
data class TaskResponse(val task: TaskDto)

@Serializable
data class LlmConfigDto(
    val id: String,
    val name: String,
    val baseUrl: String,
    val model: String,
    val hasApiKey: Boolean = false,
    val thinkingLevel: String = "off",
    val temperature: Double? = null,
    val maxTokens: Int? = null,
    val contextWindow: Int? = null,
    val systemPromptExtra: String? = null,
    val timeoutSeconds: Int? = null,
    val maxRetries: Int? = null,
    val requestsPerMinute: Int? = null,
    val maxTokensPerRun: Int? = null,
    val customHeaders: Map<String, String>? = null,
    val isDefault: Boolean = false,
    val enabled: Boolean = true,
    val createdAt: String? = null,
    val updatedAt: String? = null,
)

@Serializable
data class LlmConfigsResponse(val configs: List<LlmConfigDto>)

/** Create/update payload; null optionals are omitted from the JSON body. */
@Serializable
data class LlmConfigPayload(
    val name: String,
    val baseUrl: String,
    val model: String,
    val apiKey: String? = null,
    val thinkingLevel: String? = null,
    val temperature: Double? = null,
    val maxTokens: Int? = null,
    val contextWindow: Int? = null,
    val systemPromptExtra: String? = null,
    val timeoutSeconds: Int? = null,
    val maxRetries: Int? = null,
    val requestsPerMinute: Int? = null,
    val maxTokensPerRun: Int? = null,
    val customHeaders: Map<String, String>? = null,
    val isDefault: Boolean? = null,
    val enabled: Boolean? = null,
)

@Serializable
data class LlmTestResult(
    val ok: Boolean,
    val latencyMs: Long? = null,
    val modelEcho: String? = null,
    val reply: String? = null,
    val error: String? = null,
)

/** Shape of error bodies returned by the backend (`{"error": "..."}`). */
@Serializable
data class ErrorResponse(val error: String? = null)
