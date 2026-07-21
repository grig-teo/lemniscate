package space.grigteo.lemniscate

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import space.grigteo.lemniscate.core.api.ApiClient
import space.grigteo.lemniscate.core.api.LemniscateApi
import space.grigteo.lemniscate.core.api.SessionCookieJar
import space.grigteo.lemniscate.core.api.SessionStore

/** Application-scoped singletons: session persistence, cookie jar, API client. */
class LemniscateApp : Application() {

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    lateinit var sessionStore: SessionStore
        private set
    lateinit var cookieJar: SessionCookieJar
        private set
    lateinit var api: LemniscateApi
        private set

    override fun onCreate() {
        super.onCreate()
        sessionStore = SessionStore(this)
        cookieJar = SessionCookieJar(sessionStore, appScope)
        api = ApiClient.create(cookieJar)
        appScope.launch { cookieJar.loadPersisted() }
    }
}
