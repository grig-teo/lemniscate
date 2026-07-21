package space.grigteo.lemniscate.core

import space.grigteo.lemniscate.core.api.RepositoryDto

data class ConnectionGroup(
    val connectionId: String,
    val provider: String,
    val username: String,
    val repos: List<RepositoryDto>,
)

/** Group repositories by their git-host connection, groups sorted by provider. */
fun groupByConnection(repos: List<RepositoryDto>): List<ConnectionGroup> {
    val groups = LinkedHashMap<String, MutableList<RepositoryDto>>()
    for (repo in repos) groups.getOrPut(repo.connectionId) { mutableListOf() }.add(repo)
    return repos
        .distinctBy { it.connectionId }
        .map { repo ->
            ConnectionGroup(
                connectionId = repo.connectionId,
                provider = repo.connection.provider,
                username = repo.connection.username,
                repos = groups.getValue(repo.connectionId),
            )
        }
        .sortedBy { it.provider }
}
