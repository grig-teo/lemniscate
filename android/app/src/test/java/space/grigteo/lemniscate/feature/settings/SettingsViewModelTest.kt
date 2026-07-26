package space.grigteo.lemniscate.feature.settings

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import space.grigteo.lemniscate.core.api.ConnectionsResponse
import space.grigteo.lemniscate.core.api.LlmConfigPayload
import space.grigteo.lemniscate.core.api.LlmConfigsResponse
import space.grigteo.lemniscate.core.api.LlmTestResult
import space.grigteo.lemniscate.testing.FakeLemniscateApi
import space.grigteo.lemniscate.testing.MainDispatcherRule

@OptIn(ExperimentalCoroutinesApi::class)
class SettingsViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private fun viewModel(api: FakeLemniscateApi): SettingsViewModel {
        api.connectionsResult = { ConnectionsResponse(emptyList()) }
        api.llmConfigsResult = { LlmConfigsResponse(emptyList()) }
        return SettingsViewModel(api) { "token" }
    }

    @Test
    fun `init refresh populates connections and configs`() = runTest {
        val vm = viewModel(FakeLemniscateApi())
        advanceUntilIdle()
        assertFalse(vm.ui.value.loading)
        assertNull(vm.ui.value.snackbar)
        assertEquals("token", vm.currentSessionToken)
    }

    @Test
    fun `refresh failure surfaces a snackbar`() = runTest {
        val api = FakeLemniscateApi()
        api.connectionsResult = { throw IllegalStateException("boom") }
        api.llmConfigsResult = { LlmConfigsResponse(emptyList()) }
        val vm = SettingsViewModel(api) { null }
        advanceUntilIdle()
        assertFalse(vm.ui.value.loading)
        assertEquals("boom", vm.ui.value.snackbar)
        vm.dismissSnackbar()
        assertNull(vm.ui.value.snackbar)
    }

    @Test
    fun `disconnect failure keeps list stable and reports the error`() = runTest {
        val api = FakeLemniscateApi()
        api.disconnectError = IllegalStateException("cannot disconnect")
        val vm = viewModel(api)
        advanceUntilIdle()
        vm.disconnect("conn_1")
        advanceUntilIdle()
        assertFalse(vm.ui.value.busy)
        assertEquals("cannot disconnect", vm.ui.value.snackbar)
    }

    @Test
    fun `deleteLlmConfig calls the API and refreshes`() = runTest {
        val api = FakeLemniscateApi()
        val vm = viewModel(api)
        advanceUntilIdle()
        vm.deleteLlmConfig("cfg_1")
        advanceUntilIdle()
        assertEquals(listOf("cfg_1"), api.deletedLlmConfigIds)
        assertFalse(vm.ui.value.busy)
        assertNull(vm.ui.value.snackbar)
    }

    @Test
    fun `testLlmConfig failure returns an error result instead of throwing`() = runTest {
        val api = FakeLemniscateApi()
        api.testLlmConfigResult = { throw IllegalStateException("unreachable") }
        val vm = viewModel(api)
        advanceUntilIdle()
        val result = vm.testLlmConfig(null, LlmConfigPayload(name = "n", baseUrl = "b", model = "m"))
        assertFalse(result.ok)
        assertEquals("unreachable", result.error)
    }

    @Test
    fun `testLlmConfig on a saved config delegates to the saved endpoint`() = runTest {
        val api = FakeLemniscateApi()
        api.testSavedLlmConfigResult = { id ->
            assertEquals("cfg_9", id)
            LlmTestResult(ok = true, latencyMs = 12)
        }
        val vm = viewModel(api)
        advanceUntilIdle()
        val result = vm.testLlmConfig("cfg_9", LlmConfigPayload(name = "n", baseUrl = "b", model = "m"))
        assert(result.ok)
        assertEquals(12L, result.latencyMs)
    }
}
