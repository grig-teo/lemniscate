package space.grigteo.lemniscate.feature.auth

import android.graphics.Bitmap
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import space.grigteo.lemniscate.core.Env

/** Extract the lemniscate session token from a CookieManager cookie header. */
internal fun extractSessionToken(cookieHeader: String?): String? {
    if (cookieHeader.isNullOrBlank()) return null
    return cookieHeader.split(';')
        .map { it.trim() }
        .firstOrNull { it.startsWith("${Env.SESSION_COOKIE}=") }
        ?.substringAfter('=')
        ?.takeIf { it.isNotBlank() }
}

/**
 * Full-screen WebView running the backend OAuth flow. When the flow finishes,
 * the backend redirects to the web app's /dashboard; we intercept that
 * navigation, harvest the session cookie and report it via [onAuthenticated].
 */
@Composable
fun OAuthWebViewDialog(
    url: String,
    title: String,
    sessionToken: String? = null,
    onAuthenticated: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(modifier = Modifier.fillMaxSize()) {
            Column {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close")
                    }
                }
                OAuthWebView(url, sessionToken, onAuthenticated, modifier = Modifier.fillMaxSize())
            }
        }
    }
}

@Composable
private fun OAuthWebView(
    url: String,
    sessionToken: String?,
    onAuthenticated: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                val cookies = CookieManager.getInstance()
                cookies.setAcceptCookie(true)
                // Carry an existing session (e.g. from a token login) so the
                // backend links the new connection to the signed-in user.
                if (sessionToken != null) {
                    cookies.setCookie(Env.serverUrl, "${Env.SESSION_COOKIE}=$sessionToken")
                }
                webViewClient = LoginWebViewClient(onAuthenticated)
                loadUrl(url)
            }
        },
    )
}

private class LoginWebViewClient(
    private val onAuthenticated: (String) -> Unit,
) : WebViewClient() {

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        if (!url.endsWith(Env.LOGIN_SUCCESS_SUFFIX)) return
        view.stopLoading()
        val token = extractSessionToken(CookieManager.getInstance().getCookie(Env.serverUrl))
        if (token != null) onAuthenticated(token)
    }
}
