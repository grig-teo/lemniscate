package space.grigteo.lemniscate.core

/** Single source of truth for git-host provider presentation (mirrors web providers.tsx). */
object Providers {
    const val GITHUB = "github"
    const val GITLAB = "gitlab"
    const val GITVERSE = "gitverse"

    private val brandLabels = mapOf(
        GITHUB to "GitHub",
        GITLAB to "GitLab",
        GITVERSE to "GitVerse",
    )

    fun label(provider: String): String =
        brandLabels[provider.lowercase()]
            ?: provider.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
}
