import Foundation

@MainActor
final class ConnectionsViewModel: ObservableObject {
    enum ConnectionSheet: Identifiable {
        case oauth(provider: String)
        case gitverse

        var id: String {
            switch self {
            case .oauth(let provider): return "oauth-\(provider)"
            case .gitverse: return "gitverse"
            }
        }
    }

    @Published private(set) var connections: [GitConnection] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published var sheet: ConnectionSheet?

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: ConnectionsResponse =
                try await APIClient.shared.request("GET", "api/connections")
            connections = response.connections
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func delete(_ connection: GitConnection) async {
        do {
            try await APIClient.shared.send("DELETE", "api/connections/\(connection.id)")
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func sync(_ connection: GitConnection) async {
        do {
            try await APIClient.shared.send("POST", "api/connections/\(connection.id)/sync")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func connectGitVerse(token: String, baseUrl: String?) async throws {
        let body = ConnectBody(provider: "gitverse", token: token, baseUrl: baseUrl)
        try await APIClient.shared.send("POST", "api/connections", body: body)
    }
}
