package space.grigteo.lemniscate.core.api

import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import space.grigteo.lemniscate.core.Env

/** Shared JSON config: tolerant of unknown fields, omits null payload fields. */
val apiJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}

/**
 * CookieJar holding only the lemniscate session cookie. The value is kept in
 * memory for requests and mirrored to DataStore so the session survives
 * restarts. Cookies set by responses (e.g. GitVerse PAT login) are captured
 * automatically; the OAuth WebView flow injects the harvested cookie via
 * [setToken].
 */
class SessionCookieJar(
    private val store: SessionStore,
    private val scope: CoroutineScope,
) : CookieJar {

    private val tokenRef = AtomicReference<String?>(null)

    val currentToken: String? get() = tokenRef.get()

    suspend fun loadPersisted() {
        tokenRef.set(store.token.first())
    }

    fun setToken(token: String?) {
        tokenRef.set(token)
        scope.launch { store.saveToken(token) }
    }

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val session = cookies.firstOrNull { it.name == Env.SESSION_COOKIE } ?: return
        setToken(session.value.ifBlank { null })
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val token = tokenRef.get() ?: return emptyList()
        val cookie = Cookie.Builder()
            .name(Env.SESSION_COOKIE)
            .value(token)
            .domain(url.host)
            .path("/")
            .secure()
            .build()
        return listOf(cookie)
    }
}

object ApiClient {

    fun create(cookieJar: SessionCookieJar): LemniscateApi {
        val client = OkHttpClient.Builder()
            .cookieJar(cookieJar)
            .addInterceptor(logging())
            .build()
        return Retrofit.Builder()
            .baseUrl("${Env.serverUrl}/")
            .client(client)
            .addConverterFactory(apiJson.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(LemniscateApi::class.java)
    }

    private fun logging() = HttpLoggingInterceptor().apply {
        level = HttpLoggingInterceptor.Level.BASIC
        redactHeader("Cookie")
        redactHeader("Set-Cookie")
    }
}
