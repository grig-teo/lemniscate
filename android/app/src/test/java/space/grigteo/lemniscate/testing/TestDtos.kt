package space.grigteo.lemniscate.testing

import space.grigteo.lemniscate.core.api.RepoConnectionRef
import space.grigteo.lemniscate.core.api.RepositoryDto
import space.grigteo.lemniscate.core.api.TaskDto

fun repoDto(
    id: String,
    connectionId: String,
    provider: String = "github",
    username: String = "octocat",
    name: String = id,
) = RepositoryDto(
    id = id,
    connectionId = connectionId,
    name = name,
    fullName = "$username/$name",
    connection = RepoConnectionRef(provider = provider, username = username),
)

fun taskDto(id: String, repositoryId: String, status: String, kind: String = "prompt") = TaskDto(
    id = id,
    repositoryId = repositoryId,
    kind = kind,
    status = status,
)
