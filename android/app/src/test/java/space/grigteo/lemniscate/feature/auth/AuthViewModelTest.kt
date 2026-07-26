package space.grigteo.lemniscate.feature.auth

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import space.grigteo.lemniscate.testing.FakeLemniscateApi
import space.grigteo.lemniscate.testing.MainDispatcherRule

@OptIn(ExperimentalCoroutinesApi::class)
class AuthViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun `completeOAuth stores the token and reports login`() {
        val stored = mutableListOf<String?>()
        var loggedIn = false
        val vm = AuthViewModel(FakeLemniscateApi()) { stored += it }
        vm.completeOAuth("token-123") { loggedIn = true }
        assertEquals(listOf("token-123"), stored)
        assert(loggedIn)
    }

    @Test
    fun `connectWithToken posts a trimmed payload and reports login`() = runTest {
        val api = FakeLemniscateApi()
        var loggedIn = false
        val vm = AuthViewModel(api) {}
        vm.connectWithToken("gitverse", "  pat-1  ", " https://gitverse.ru ", onLoggedIn = { loggedIn = true })
        assert(vm.busy)
        advanceUntilIdle()
        assertFalse(vm.busy)
        assert(loggedIn)
        assertNull(vm.error)
        assertEquals(1, api.connectCalls.size)
        assertEquals("gitverse", api.connectCalls[0].provider)
        assertEquals("pat-1", api.connectCalls[0].token)
        assertEquals("https://gitverse.ru", api.connectCalls[0].baseUrl)
    }

    @Test
    fun `blank base url is sent as null`() = runTest {
        val api = FakeLemniscateApi()
        val vm = AuthViewModel(api) {}
        vm.connectWithToken("gitverse", "pat-1", "  ", onLoggedIn = {})
        advanceUntilIdle()
        assertNull(api.connectCalls[0].baseUrl)
    }

    @Test
    fun `connect failure surfaces the error and does not report login`() = runTest {
        val api = FakeLemniscateApi()
        api.connectError = IllegalStateException("invalid token")
        var loggedIn = false
        val vm = AuthViewModel(api) {}
        vm.connectWithToken("gitverse", "pat-1", null, onLoggedIn = { loggedIn = true })
        advanceUntilIdle()
        assertFalse(vm.busy)
        assertFalse(loggedIn)
        assertEquals("invalid token", vm.error)
    }
}
