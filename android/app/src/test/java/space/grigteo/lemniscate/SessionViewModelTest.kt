package space.grigteo.lemniscate

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import space.grigteo.lemniscate.core.api.MeResponse
import space.grigteo.lemniscate.core.api.UserDto
import space.grigteo.lemniscate.testing.FakeLemniscateApi
import space.grigteo.lemniscate.testing.MainDispatcherRule
import okhttp3.ResponseBody.Companion.toResponseBody
import retrofit2.HttpException
import retrofit2.Response

@OptIn(ExperimentalCoroutinesApi::class)
class SessionViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private fun httpError(code: Int) =
        HttpException(Response.error<Any>(code, "{}".toResponseBody(null)))

    @Test
    fun `no stored token means logged out without hitting the API`() = runTest {
        val api = FakeLemniscateApi()
        val vm = SessionViewModel(api, MutableStateFlow(null)) {}
        advanceUntilIdle()
        assertEquals(SessionState.LoggedOut, vm.state.value)
    }

    @Test
    fun `stored token plus successful me means logged in`() = runTest {
        val api = FakeLemniscateApi()
        api.meResult = { MeResponse(UserDto(id = "user_1")) }
        val vm = SessionViewModel(api, MutableStateFlow("token")) {}
        advanceUntilIdle()
        assertEquals(SessionState.LoggedIn, vm.state.value)
    }

    @Test
    fun `expired session clears the stored token`() = runTest {
        val api = FakeLemniscateApi()
        api.meResult = { throw httpError(401) }
        var cleared = false
        val vm = SessionViewModel(api, MutableStateFlow("stale")) { cleared = true }
        advanceUntilIdle()
        assertEquals(SessionState.LoggedOut, vm.state.value)
        assert(cleared)
    }

    @Test
    fun `server error keeps the stored token for retry`() = runTest {
        val api = FakeLemniscateApi()
        api.meResult = { throw httpError(500) }
        var cleared = false
        val vm = SessionViewModel(api, MutableStateFlow("token")) { cleared = true }
        advanceUntilIdle()
        assertEquals(SessionState.LoggedOut, vm.state.value)
        assert(!cleared)
    }

    @Test
    fun `network failure keeps the stored token for retry`() = runTest {
        val api = FakeLemniscateApi()
        api.meResult = { throw java.io.IOException("offline") }
        var cleared = false
        val vm = SessionViewModel(api, MutableStateFlow("token")) { cleared = true }
        advanceUntilIdle()
        assertEquals(SessionState.LoggedOut, vm.state.value)
        assert(!cleared)
    }

    @Test
    fun `onLoggedIn flips state to logged in`() = runTest {
        val vm = SessionViewModel(FakeLemniscateApi(), MutableStateFlow(null)) {}
        advanceUntilIdle()
        vm.onLoggedIn()
        assertEquals(SessionState.LoggedIn, vm.state.value)
    }
}
