package space.grigteo.lemniscate.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import space.grigteo.lemniscate.testing.repoDto

class GroupReposTest {

    @Test
    fun `empty list yields no groups`() {
        assertTrue(groupByConnection(emptyList()).isEmpty())
    }

    @Test
    fun `repos are grouped by connection preserving repo order within a group`() {
        val repos = listOf(
            repoDto("r1", "c1"),
            repoDto("r2", "c2"),
            repoDto("r3", "c1"),
        )
        val groups = groupByConnection(repos)
        assertEquals(2, groups.size)
        assertEquals(listOf("r1", "r3"), groups.first { it.connectionId == "c1" }.repos.map { it.id })
        assertEquals(listOf("r2"), groups.first { it.connectionId == "c2" }.repos.map { it.id })
    }

    @Test
    fun `groups are sorted by provider`() {
        val repos = listOf(
            repoDto("r1", "c1", provider = "gitverse"),
            repoDto("r2", "c2", provider = "github"),
            repoDto("r3", "c3", provider = "gitlab"),
        )
        assertEquals(listOf("github", "gitlab", "gitverse"), groupByConnection(repos).map { it.provider })
    }

    @Test
    fun `group carries provider and username from the connection ref`() {
        val group = groupByConnection(listOf(repoDto("r1", "c1", provider = "github", username = "octocat"))).single()
        assertEquals("github", group.provider)
        assertEquals("octocat", group.username)
    }
}
