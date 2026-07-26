import XCTest
@testable import Lemniscate

@MainActor
final class MainViewModelTests: XCTestCase {

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: "selectedRepository")
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "selectedRepository")
        super.tearDown()
    }

    private func taskResponse(id: String = "task_1", repositoryId: String = "r1") -> TaskResponse {
        TaskResponse(task: TestDTOs.task(id: id, repositoryId: repositoryId, status: "queued"))
    }

    func testMicEnabledOnlyWithSelectionAndNotSending() {
        let vm = MainViewModel(api: StubAPIClient())
        XCTAssertFalse(vm.micEnabled)
        vm.selectedRepo = TestDTOs.repository(id: "r1", connectionId: "c1")
        XCTAssertTrue(vm.micEnabled)
        vm.isSending = true
        XCTAssertFalse(vm.micEnabled)
    }

    func testSubmitPostsTaskAndClearsTranscript() async {
        let stub = StubAPIClient(responses: ["api/tasks": taskResponse()])
        let vm = MainViewModel(api: stub)
        vm.transcript = "fix the login crash"
        await vm.submit(prompt: "fix the login crash", repositoryId: "r1")
        XCTAssertEqual(vm.transcript, "")
        XCTAssertFalse(vm.isSending)
        XCTAssertNil(vm.alertMessage)
        XCTAssertEqual(stub.calls.map(\.path), ["api/tasks"])
        XCTAssertEqual(stub.calls.map(\.method), ["POST"])
        let body = stub.lastBody as? CreateTaskBody
        XCTAssertEqual(body?.repositoryId, "r1")
        XCTAssertEqual(body?.prompt, "fix the login crash")
    }

    func testSubmitFailureKeepsTranscriptAndShowsAlert() async {
        let stub = StubAPIClient(error: ApiError.server(status: 500, message: "queue full"))
        let vm = MainViewModel(api: stub)
        vm.transcript = "fix it"
        await vm.submit(prompt: "fix it", repositoryId: "r1")
        XCTAssertEqual(vm.transcript, "fix it")
        XCTAssertFalse(vm.isSending)
        XCTAssertEqual(vm.alertMessage, "queue full")
    }

    func testSelectingARepoPersistsItAcrossInstances() {
        let repo = TestDTOs.repository(id: "r1", connectionId: "c1")
        let vm = MainViewModel(api: StubAPIClient())
        vm.selectedRepo = repo
        let reloaded = MainViewModel(api: StubAPIClient())
        XCTAssertEqual(reloaded.selectedRepo?.id, "r1")

        reloaded.selectedRepo = nil
        let cleared = MainViewModel(api: StubAPIClient())
        XCTAssertNil(cleared.selectedRepo)
    }
}
