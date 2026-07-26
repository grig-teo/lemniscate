import XCTest
@testable import Lemniscate

final class EndpointsTests: XCTestCase {

    func testPathComponentsAreAppendedToTheBaseURL() {
        let url = Endpoints.url("api/tasks")
        XCTAssertEqual(
            url.absoluteString,
            Env.serverURL.appending(path: "api").appending(path: "tasks").absoluteString
        )
    }

    func testLeadingSlashInPathIsNotDoubled() {
        XCTAssertEqual(Endpoints.url("/api/auth/me").path, Endpoints.url("api/auth/me").path)
    }

    func testQueryItemsAreEncodedIntoTheURL() {
        let url = Endpoints.url("api/tasks", query: [URLQueryItem(name: "repositoryId", value: "repo_1")])
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        XCTAssertEqual(components?.queryItems, [URLQueryItem(name: "repositoryId", value: "repo_1")])
        XCTAssertTrue(url.absoluteString.contains("repositoryId=repo_1"))
    }

    func testOAuthURLPointsAtTheProviderAuthRoute() {
        let url = Endpoints.oauth(provider: "github")
        XCTAssertTrue(url.absoluteString.hasSuffix("/api/auth/github"))
    }
}
