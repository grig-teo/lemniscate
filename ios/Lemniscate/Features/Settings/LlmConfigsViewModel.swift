import Foundation

@MainActor
final class LlmConfigsViewModel: ObservableObject {
    enum FormTarget: Identifiable {
        case add
        case edit(LlmConfig)

        var id: String {
            switch self {
            case .add: return "add"
            case .edit(let config): return config.id
            }
        }
    }

    @Published private(set) var configs: [LlmConfig] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published var formTarget: FormTarget?

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: LlmConfigsResponse =
                try await APIClient.shared.request("GET", "api/llm-configs")
            configs = response.configs
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func delete(_ config: LlmConfig) async {
        do {
            try await APIClient.shared.send("DELETE", "api/llm-configs/\(config.id)")
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
