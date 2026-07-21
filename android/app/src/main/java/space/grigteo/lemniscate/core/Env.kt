package space.grigteo.lemniscate.core

import space.grigteo.lemniscate.BuildConfig

/** Build-time configuration injected from local.properties via BuildConfig. */
object Env {
    val serverUrl: String = BuildConfig.SERVER_URL.trimEnd('/')

    /** Path the OAuth flow redirects to on success; marks login completion. */
    const val LOGIN_SUCCESS_SUFFIX = "/dashboard"

    /** Name of the session cookie issued by the backend. */
    const val SESSION_COOKIE = "lemniscate_token"
}
