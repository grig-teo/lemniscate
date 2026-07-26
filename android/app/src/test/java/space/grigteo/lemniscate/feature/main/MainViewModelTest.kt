package space.grigteo.lemniscate.feature.main

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import space.grigteo.lemniscate.core.api.RepositoriesResponse
import space.grigteo.lemniscate.core.api.TasksResponse
import space.grigteo.lemniscate.testing.FakeLemniscateApi
import space.grigteo.lemniscate.testing.FakeRepoSelectionStore
import space.grigteo.lemniscate.testing.MainDispatcherRule
import space.grigteo.lemniscate.testing.repoDto
import space.grigteo.lemniscate.testing.taskDto

@OptIn(ExperimentalCoroutinesApi::class)
class MainViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private val repos = listOf(
        repoDto("r1", "c1", provider = "github"),
        repoDto("r2", "c2", provider = "gitverse"),
    )

    private fun viewModel(
        api: FakeLemniscateApi,
        selection: FakeRepoSelectionStore = FakeRepoSelectionStore(),
    ): MainViewModel {
        api.repositoriesResult = { RepositoriesResponse(repos) }
        return MainViewModel(api, selection)
    }

    @Test
    fun `init loads repositories grouped by connection`() = runTest {
        val vm = viewModel(FakeLemniscateApi())
        advanceUntilIdle()
        val state = vm.ui.value
        assertFalse(state.loading)
        assertEquals(2, state.groups.size)
        assertNull(state.snackbar)
    }

    @Test
    fun `load failure surfaces a snackbar`() = runTest {
        val api = FakeLemniscateApi()
        api.repositoriesResult = { throw IllegalStateException("boom") }
        val vm = MainViewModel(api, FakeRepoSelectionStore())
        advanceUntilIdle()
        assertFalse(vm.ui.value.loading)
        assertEquals("boom", vm.ui.value.snackbar)
    }

    @Test
    fun `saved selection is restored when the repo still exists`() = runTest {
        val vm = viewModel(FakeLemniscateApi(), FakeRepoSelectionStore(initialId = "r2"))
        advanceUntilIdle()
        assertEquals("r2", vm.ui.value.selectedRepo?.id)
    }

    @Test
    fun `stale saved selection is ignored`() = runTest {
        val vm = viewModel(FakeLemniscateApi(), FakeRepoSelectionStore(initialId = "gone"))
        advanceUntilIdle()
        assertNull(vm.ui.value.selectedRepo)
    }

    @Test
    fun `selectRepo updates state and persists the id`() = runTest {
        val selection = FakeRepoSelectionStore()
        val vm = viewModel(FakeLemniscateApi(), selection)
        advanceUntilIdle()
        vm.selectRepo(repos[0])
        advanceUntilIdle()
        assertEquals("r1", vm.ui.value.selectedRepo?.id)
        assertEquals("r1", selection.selectedRepoId.first())
    }

    @Test
    fun `submitPrompt posts the trimmed transcript and clears it`() = runTest {
        val api = FakeLemniscateApi()
        val vm = viewModel(api, FakeRepoSelectionStore(initialId = "r1"))
        advanceUntilIdle()
        vm.editTranscript("  fix the login crash  ")
        vm.submitPrompt()
        advanceUntilIdle()
        assertEquals(1, api.createdTasks.size)
        assertEquals("r1", api.createdTasks[0].repositoryId)
        assertEquals("fix the login crash", api.createdTasks[0].prompt)
        assertEquals("", vm.ui.value.transcript)
        assertFalse(vm.ui.value.sending)
    }

    @Test
    fun `submitPrompt without a selected repo is a no-op`() = runTest {
        val api = FakeLemniscateApi()
        val vm = viewModel(api)
        advanceUntilIdle()
        vm.editTranscript("hello")
        vm.submitPrompt()
        advanceUntilIdle()
        assertTrue(api.createdTasks.isEmpty())
    }

    @Test
    fun `submitPrompt with blank transcript is a no-op`() = runTest {
        val api = FakeLemniscateApi()
        val vm = viewModel(api, FakeRepoSelectionStore(initialId = "r1"))
        advanceUntilIdle()
        vm.editTranscript("   ")
        vm.submitPrompt()
        advanceUntilIdle()
        assertTrue(api.createdTasks.isEmpty())
    }

    @Test
    fun `submitPrompt failure keeps the transcript and shows a snackbar`() = runTest {
        val api = FakeLemniscateApi()
        api.createTaskError = IllegalStateException("server down")
        val vm = viewModel(api, FakeRepoSelectionStore(initialId = "r1"))
        advanceUntilIdle()
        vm.editTranscript("fix it")
        vm.submitPrompt()
        advanceUntilIdle()
        assertEquals("fix it", vm.ui.value.transcript)
        assertEquals("server down", vm.ui.value.snackbar)
        assertFalse(vm.ui.value.sending)
    }

    @Test
    fun `final transcript appends to committed text and clears partial`() = runTest {
        val vm = viewModel(FakeLemniscateApi())
        advanceUntilIdle()
        vm.onFinalTranscript("first")
        vm.onPartialTranscript("typ")
        vm.onFinalTranscript("second")
        assertEquals("first second", vm.ui.value.transcript)
        assertEquals("", vm.ui.value.partialTranscript)
    }

    @Test
    fun `loadRunningTasks keeps only queued and running tasks`() = runTest {
        val api = FakeLemniscateApi()
        api.tasksResult = { repoId ->
            assertEquals("r1", repoId)
            TasksResponse(
                listOf(
                    taskDto("t1", repoId, "queued"),
                    taskDto("t2", repoId, "running"),
                    taskDto("t3", repoId, "done"),
                    taskDto("t4", repoId, "failed", kind = "proposal"),
                ),
            )
        }
        val vm = viewModel(api)
        advanceUntilIdle()
        vm.loadRunningTasks("r1")
        advanceUntilIdle()
        assertEquals(listOf("t1", "t2"), vm.ui.value.runningTasks.getValue("r1").map { it.id })
    }
}
