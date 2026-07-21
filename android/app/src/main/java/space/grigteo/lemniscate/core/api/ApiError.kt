package space.grigteo.lemniscate.core.api

import retrofit2.HttpException

/** Extract a user-presentable message from any API failure. */
fun Throwable.friendlyMessage(): String {
    if (this is HttpException) {
        val body = response()?.errorBody()?.string()
        val parsed = body?.let { runCatching { apiJson.decodeFromString<ErrorResponse>(it) }.getOrNull() }
        parsed?.error?.takeIf { it.isNotBlank() }?.let { return it }
        return "HTTP ${code()}"
    }
    return message ?: "Unknown error"
}
