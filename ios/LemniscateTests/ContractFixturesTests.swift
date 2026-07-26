import XCTest
@testable import Lemniscate

/// Decodes the shared fixtures in tests/contract/ (exported from the backend
/// payload shapes). A backend field rename or enum/shape change that the apps
/// rely on must fail here and in the Android mirror (ContractFixturesTest.kt).
final class ContractFixturesTests: XCTestCase {

    func testTasksResponseDecodesPromptAndProposalTasks() throws {
        let response = try FixtureLoader.decode("tasks-response", as: TasksResponse.self)
        XCTAssertEqual(response.tasks.count, 4)

        let byId = Dictionary(uniqueKeysWithValues: response.tasks.map { ($0.id, $0) })

        let prompt = try XCTUnwrap(byId["task_prompt_1"])
        XCTAssertEqual(prompt.kind, "prompt")
        XCTAssertEqual(prompt.status, "queued")
        XCTAssertEqual(prompt.repositoryId, "repo_1")
        XCTAssertEqual(prompt.llmConfigId, "cfg_1")
        XCTAssertTrue(prompt.isRunning)

        let running = try XCTUnwrap(byId["task_prompt_2"])
        XCTAssertEqual(running.status, "running")
        XCTAssertEqual(running.branchName, "agent/dark-mode-toggle")
        XCTAssertTrue(running.isRunning)

        let proposal = try XCTUnwrap(byId["task_proposal_1"])
        XCTAssertEqual(proposal.kind, "proposal")
        XCTAssertEqual(proposal.status, "done")
        XCTAssertEqual(proposal.prUrl, "https://github.com/example/app/pull/42")
        XCTAssertNil(proposal.prompt)
        XCTAssertFalse(proposal.isRunning)

        let failed = try XCTUnwrap(byId["task_proposal_2"])
        XCTAssertEqual(failed.status, "failed")
        XCTAssertEqual(failed.error, "agent exited with code 1")
        XCTAssertFalse(failed.isRunning)
    }

    func testRepositoriesResponseDecodesReposWithConnectionRefs() throws {
        let response = try FixtureLoader.decode("repositories-response", as: RepositoriesResponse.self)
        XCTAssertEqual(response.repositories.count, 2)

        let repo = try XCTUnwrap(response.repositories.first { $0.id == "repo_1" })
        XCTAssertEqual(repo.connectionId, "conn_github")
        XCTAssertEqual(repo.fullName, "octocat/app")
        XCTAssertEqual(repo.defaultBranch, "main")
        XCTAssertEqual(repo.autoPropose, true)
        XCTAssertEqual(repo.connection?.provider, "github")
        XCTAssertEqual(repo.connection?.username, "octocat")

        let gitverse = try XCTUnwrap(response.repositories.first { $0.id == "repo_2" })
        XCTAssertEqual(gitverse.connection?.provider, "gitverse")
        XCTAssertNil(gitverse.llmConfigId)
    }
}
