package space.grigteo.lemniscate.core.api

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.sessionDataStore by preferencesDataStore(name = "session")

/** Persists the session cookie and the last selected repository across restarts. */
class SessionStore(private val context: Context) {

    private val tokenKey = stringPreferencesKey("session_token")
    private val selectedRepoKey = stringPreferencesKey("selected_repo_id")

    val token: Flow<String?> = context.sessionDataStore.data.map { it[tokenKey] }
    val selectedRepoId: Flow<String?> = context.sessionDataStore.data.map { it[selectedRepoKey] }

    suspend fun saveToken(token: String?) {
        context.sessionDataStore.edit { prefs ->
            if (token == null) prefs.remove(tokenKey) else prefs[tokenKey] = token
        }
    }

    suspend fun saveSelectedRepoId(id: String?) {
        context.sessionDataStore.edit { prefs ->
            if (id == null) prefs.remove(selectedRepoKey) else prefs[selectedRepoKey] = id
        }
    }
}
