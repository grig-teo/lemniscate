package space.grigteo.lemniscate.core.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.grigteo.lemniscate.testing.ContractFixtures

/**
 * Decodes the shared fixtures in tests/contract/ (exported from the backend
 * payload shapes). A backend field rename or enum/shape change that the apps
 * rely on must fail here and in the iOS mirror (ContractFixturesTests.swift).
 */
class ContractFixturesTest {

    @Test
    fun `tasks response decodes prompt and proposal tasks with statuses`() {
        val decoded = apiJson.decodeFromString<TasksResponse>(ContractFixtures.read("tasks-response.json"))
        assertEquals(4, decoded.tasks.size)

        val byId = decoded.tasks.associateBy { it.id }
        val prompt = byId.getValue("task_prompt_1")
        assertEquals("prompt", prompt.kind)
        assertEquals("queued", prompt.status)
        assertEquals("repo_1", prompt.repositoryId)
        assertEquals("cfg_1", prompt.llmConfigId)
        assertTrue(prompt.isRunning)

        val running = byId.getValue("task_prompt_2")
        assertEquals("running", running.status)
        assertEquals("agent/dark-mode-toggle", running.branchName)
        assertTrue(running.isRunning)

        val proposal = byId.getValue("task_proposal_1")
        assertEquals("proposal", proposal.kind)
        assertEquals("done", proposal.status)
        assertEquals("https://github.com/example/app/pull/42", proposal.prUrl)
        assertNull(proposal.prompt)
        assertTrue(!proposal.isRunning)

        val failed = byId.getValue("task_proposal_2")
        assertEquals("failed", failed.status)
        assertEquals("agent exited with code 1", failed.error)
        assertTrue(!failed.isRunning)
    }

    @Test
    fun `repositories response decodes repos with connection refs`() {
        val decoded =
            apiJson.decodeFromString<RepositoriesResponse>(ContractFixtures.read("repositories-response.json"))
        assertEquals(2, decoded.repositories.size)

        val repo = decoded.repositories.first { it.id == "repo_1" }
        assertEquals("conn_github", repo.connectionId)
        assertEquals("octocat/app", repo.fullName)
        assertEquals("main", repo.defaultBranch)
        assertEquals(true, repo.autoPropose)
        assertEquals("github", repo.connection.provider)
        assertEquals("octocat", repo.connection.username)

        val gitverse = decoded.repositories.first { it.id == "repo_2" }
        assertEquals("gitverse", gitverse.connection.provider)
        assertNull(gitverse.llmConfigId)
    }
}
