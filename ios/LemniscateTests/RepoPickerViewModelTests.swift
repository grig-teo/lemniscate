import XCTest
@testable import Lemniscate

@MainActor
final class RepoPickerViewModelTests: XCTestCase {

    func testGroupSortsGroupsByProviderThenUsername() {
        let repos = [
            TestDTOs.repository(id: "r1", connectionId: "c1", provider: "gitverse", username: "zoe"),
            TestDTOs.repository(id: "r2", connectionId: "c2", provider: "github", username: "amy"),
            TestDTOs.repository(id: "r3", connectionId: "c3", provider: "github", username: "bob"),
        ]
        let groups = RepoPickerViewModel.group(repos: repos, connections: [])
        XCTAssertEqual(groups.map(\.id), ["c2", "c3", "c1"])
    }

    func testGroupSortsReposByNameCaseInsensitively() {
        let repos = [
            TestDTOs.repository(id: "r1", connectionId: "c1", name: "Zebra"),
            TestDTOs.repository(id: "r2", connectionId: "c1", name: "apple"),
        ]
        let group = RepoPickerViewModel.group(repos: repos, connections: []).first!
        XCTAssertEqual(group.repos.map(\.name), ["apple", "Zebra"])
    }

    func testGroupFallsBackToRepoConnectionRefWhenConnectionIsUnknown() {
        let repos = [TestDTOs.repository(id: "r1", connectionId: "cX", provider: "gitlab", username: "amy")]
        let group = RepoPickerViewModel.group(repos: repos, connections: []).first!
        XCTAssertEqual(group.provider, "gitlab")
        XCTAssertEqual(group.username, "amy")
    }

    func testLoadPopulatesGroupsFromTheAPI() async {
        let stub = StubAPIClient(responses: [
            "api/connections": ConnectionsResponse(connections: [
                TestDTOs.connection(id: "c1", provider: "github", username: "octocat"),
            ]),
            "api/repositories": RepositoriesResponse(repositories: [
                TestDTOs.repository(id: "r1", connectionId: "c1"),
            ]),
        ])
        let vm = RepoPickerViewModel(api: stub)
        await vm.load()
        XCTAssertFalse(vm.isLoading)
        XCTAssertNil(vm.errorMessage)
        XCTAssertEqual(vm.groups.count, 1)
        XCTAssertEqual(vm.groups.first?.provider, "github")
    }

    func testLoadFailureSurfacesAnErrorMessage() async {
        let stub = StubAPIClient(error: ApiError.transport("offline"))
        let vm = RepoPickerViewModel(api: stub)
        await vm.load()
        XCTAssertFalse(vm.isLoading)
        XCTAssertEqual(vm.errorMessage, "offline")
        XCTAssertTrue(vm.groups.isEmpty)
    }

    func testToggleExpandedLoadsOnlyRunningTasks() async {
        let stub = StubAPIClient(responses: [
            "api/tasks": TasksResponse(tasks: [
                TestDTOs.task(id: "t1", repositoryId: "r1", status: "queued"),
                TestDTOs.task(id: "t2", repositoryId: "r1", status: "running"),
                TestDTOs.task(id: "t3", repositoryId: "r1", status: "done"),
                TestDTOs.task(id: "t4", repositoryId: "r1", status: "failed", kind: "proposal"),
            ]),
        ])
        let vm = RepoPickerViewModel(api: stub)
        let repo = TestDTOs.repository(id: "r1", connectionId: "c1")
        await vm.toggleExpanded(repo)
        XCTAssertTrue(vm.expanded.contains("r1"))
        XCTAssertEqual(vm.runningTasks["r1"]?.map(\.id), ["t1", "t2"])
        XCTAssertEqual(stub.calls.last?.query, [URLQueryItem(name: "repositoryId", value: "r1")])

        await vm.toggleExpanded(repo)
        XCTAssertFalse(vm.expanded.contains("r1"))
    }
}
