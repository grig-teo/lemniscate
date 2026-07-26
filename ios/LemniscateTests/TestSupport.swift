import Foundation
@testable import Lemniscate

/// Programmable stub of the network seam. `responses` maps request paths to
/// already-decoded values; a missing entry (or `error`) throws.
final class StubAPIClient: @unchecked Sendable {
    struct Call {
        let method: String
        let path: String
        let query: [URLQueryItem]
    }

    private let lock = NSLock()
    private var responses: [String: Any]
    private(set) var calls: [Call] = []
    private(set) var lastBody: (any Encodable)?
    var error: Error?

    init(responses: [String: Any] = [:], error: Error? = nil) {
        self.responses = responses
        self.error = error
    }

    func setResponse(_ value: Any, for path: String) {
        lock.lock()
        responses[path] = value
        lock.unlock()
    }

    private func record(_ method: String, _ path: String, _ query: [URLQueryItem], _ body: (any Encodable)?) {
        lock.lock()
        calls.append(Call(method: method, path: path, query: query))
        lastBody = body
        lock.unlock()
    }

    private func response(for path: String) -> Any? {
        lock.lock()
        defer { lock.unlock() }
        return responses[path]
    }
}

extension StubAPIClient: APIClienting {
    func request<T: Decodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem],
        body: (any Encodable)?
    ) async throws -> T {
        record(method, path, query, body)
        if let error { throw error }
        guard let value = response(for: path) as? T else { throw ApiError.invalidResponse }
        return value
    }

    func send(_ method: String, _ path: String, body: (any Encodable)?) async throws {
        record(method, path, [], body)
        if let error { throw error }
    }
}

/// Loads the shared API-contract fixtures (tests/contract/ at the repo root,
/// bundled into the test target as resources — see project.yml).
enum FixtureLoader {
    static func data(_ name: String) throws -> Data {
        let bundle = Bundle(for: BundleToken.self)
        let url = bundle.url(forResource: name, withExtension: "json")
            ?? bundle.url(forResource: name, withExtension: "json", subdirectory: "contract")
        guard let url else {
            throw NSError(
                domain: "FixtureLoader",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "fixture \(name).json not in test bundle"]
            )
        }
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: data(name))
    }
}

private final class BundleToken {}

enum TestDTOs {
    static func connection(id: String, provider: String, username: String) -> GitConnection {
        GitConnection(id: id, provider: provider, baseUrl: nil, username: username, count: nil)
    }

    static func repository(
        id: String,
        connectionId: String,
        name: String? = nil,
        provider: String = "github",
        username: String = "octocat"
    ) -> Repository {
        Repository(
            id: id,
            connectionId: connectionId,
            externalId: nil,
            name: name ?? id,
            fullName: "\(username)/\(name ?? id)",
            cloneUrl: nil,
            defaultBranch: nil,
            autoPropose: nil,
            autoCreatePr: nil,
            autoReviewPr: nil,
            autoMergePr: nil,
            llmConfigId: nil,
            connection: Repository.ConnectionInfo(provider: provider, username: username)
        )
    }

    static func task(id: String, repositoryId: String, status: String, kind: String = "prompt") -> AgentTask {
        AgentTask(
            id: id,
            repositoryId: repositoryId,
            kind: kind,
            title: id,
            prompt: nil,
            status: status,
            branchName: nil,
            prUrl: nil,
            llmConfigId: nil,
            thinkingLevel: nil,
            error: nil,
            createdAt: nil,
            updatedAt: nil
        )
    }
}
