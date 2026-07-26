package space.grigteo.lemniscate.core.api

import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

class ApiErrorTest {

    private fun httpError(code: Int, body: String): HttpException =
        HttpException(Response.error<Any>(code, body.toResponseBody(null)))

    @Test
    fun `http error with backend error body surfaces the backend message`() {
        val e = httpError(400, """{"error": "repository already connected"}""")
        assertEquals("repository already connected", e.friendlyMessage())
    }

    @Test
    fun `http error with unparseable body falls back to status code`() {
        assertEquals("HTTP 500", httpError(500, "oops").friendlyMessage())
    }

    @Test
    fun `http error with blank backend message falls back to status code`() {
        assertEquals("HTTP 401", httpError(401, """{"error": " "}""").friendlyMessage())
    }

    @Test
    fun `non-http throwable surfaces its message or a fallback`() {
        assertEquals("boom", IllegalStateException("boom").friendlyMessage())
        assertEquals("Unknown error", IllegalStateException().friendlyMessage())
    }
}
