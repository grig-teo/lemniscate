import Foundation

@MainActor
final class RepoPickerViewModel: ObservableObject {
    @Published private(set) var groups: [RepoGroup] = []
    @Published private(set) var runningTasks: [String: [AgentTask]] = [:]
    @Published private(set) var expanded: Set<String> = []
    @Published private(set) var loadingTasks: Set<String> = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let connectionsRequest: ConnectionsResponse =
                APIClient.shared.request("GET", "api/connections")
            async let repositoriesRequest: RepositoriesResponse =
                APIClient.shared.request("GET", "api/repositories")
            let (connections, repositories) = try await (
                connectionsRequest.connections,
                repositoriesRequest.repositories
            )
            groups = Self.group(repos: repositories, connections: connections)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func toggleExpanded(_ repo: Repository) async {
        if expanded.contains(repo.id) {
            expanded.remove(repo.id)
            return
        }
        expanded.insert(repo.id)
        await loadTasks(for: repo)
    }

    private func loadTasks(for repo: Repository) async {
        guard !loadingTasks.contains(repo.id) else { return }
        loadingTasks.insert(repo.id)
        defer { loadingTasks.remove(repo.id) }
        do {
            let query = [URLQueryItem(name: "repositoryId", value: repo.id)]
            let response: TasksResponse = try await APIClient.shared.request(
                "GET", "api/tasks", query: query
            )
            runningTasks[repo.id] = response.tasks.filter(\.isRunning)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Groups the flat repository list by connection, mirroring the web
    /// client's grouping. Groups are sorted by provider, then username.
    static func group(repos: [Repository], connections: [GitConnection]) -> [RepoGroup] {
        var byConnection: [String: [Repository]] = [:]
        for repo in repos {
            byConnection[repo.connectionId, default: []].append(repo)
        }
        return byConnection
            .map { makeGroup(connectionId: $0.key, repos: $0.value, connections: connections) }
            .sorted { ($0.provider, $0.username) < ($1.provider, $1.username) }
    }

    private static func makeGroup(
        connectionId: String,
        repos: [Repository],
        connections: [GitConnection]
    ) -> RepoGroup {
        let connection = connections.first { $0.id == connectionId }
        return RepoGroup(
            id: connectionId,
            provider: connection?.provider ?? repos.first?.connection?.provider ?? "git",
            username: connection?.username ?? repos.first?.connection?.username ?? "",
            repos: repos.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        )
    }
}
