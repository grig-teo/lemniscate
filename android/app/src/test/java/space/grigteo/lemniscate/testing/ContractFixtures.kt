package space.grigteo.lemniscate.testing

import java.io.File

/**
 * Locates the shared API-contract fixtures (tests/contract/ at the repo
 * root) by walking up from the Gradle module working directory, so the same
 * JSON files drive both the Android and iOS contract tests.
 */
object ContractFixtures {
    fun read(name: String): String {
        var dir = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (true) {
            val candidate = File(dir, "tests/contract/$name")
            if (candidate.isFile) return candidate.readText()
            dir = dir.parentFile
                ?: error("tests/contract/$name not found above ${System.getProperty("user.dir")}")
        }
    }
}
