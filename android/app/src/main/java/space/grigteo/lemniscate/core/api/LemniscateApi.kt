package space.grigteo.lemniscate.core.api

import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * Retrofit mirror of the lemniscate backend endpoints. Every path used by the
 * app is defined here and nowhere else. Paths are relative to the server base
 * URL (see Env.serverUrl).
 */
interface LemniscateApi {

    @GET("api/auth/me")
    suspend fun me(): MeResponse

    @GET("api/connections")
    suspend fun connections(): ConnectionsResponse

    @POST("api/connections")
    suspend fun connect(@Body body: ConnectionPayload): ConnectionDto

    @DELETE("api/connections/{id}")
    suspend fun disconnect(@Path("id") id: String)

    @POST("api/connections/{id}/sync")
    suspend fun syncConnection(@Path("id") id: String)

    @GET("api/repositories")
    suspend fun repositories(): RepositoriesResponse

    @GET("api/tasks")
    suspend fun tasks(@Query("repositoryId") repositoryId: String): TasksResponse

    @POST("api/tasks")
    suspend fun createTask(@Body body: CreateTaskBody): TaskResponse

    @GET("api/llm-configs")
    suspend fun llmConfigs(): LlmConfigsResponse

    @POST("api/llm-configs")
    suspend fun createLlmConfig(@Body body: LlmConfigPayload): LlmConfigDto

    @PATCH("api/llm-configs/{id}")
    suspend fun updateLlmConfig(@Path("id") id: String, @Body body: LlmConfigPayload): LlmConfigDto

    @DELETE("api/llm-configs/{id}")
    suspend fun deleteLlmConfig(@Path("id") id: String)

    @POST("api/llm-configs/test")
    suspend fun testLlmConfig(@Body body: LlmConfigPayload): LlmTestResult

    @POST("api/llm-configs/{id}/test")
    suspend fun testSavedLlmConfig(@Path("id") id: String): LlmTestResult

    companion object {
        /** OAuth start URL for a provider (loaded in the WebView, not via Retrofit). */
        fun oauthUrl(serverUrl: String, provider: String): String =
            "$serverUrl/api/auth/$provider"
    }
}
