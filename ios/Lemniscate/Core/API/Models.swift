import Foundation

// Codable DTOs mirroring the lemniscate backend API. Dates are kept as
// strings; the app never needs to compute with them.

struct MeResponse: Decodable {
    let user: User
}

struct User: Decodable {
    let id: String
    let createdAt: String?
    let gitConnections: [ConnectionBrief]?
}

struct ConnectionBrief: Decodable, Identifiable {
    let id: String
    let provider: String
    let baseUrl: String?
    let username: String
}

struct ConnectionsResponse: Decodable {
    let connections: [GitConnection]
}

struct GitConnection: Decodable, Identifiable {
    struct RepoCount: Decodable {
        let repositories: Int
    }

    let id: String
    let provider: String
    let baseUrl: String?
    let username: String
    let count: RepoCount?

    enum CodingKeys: String, CodingKey {
        case id, provider, baseUrl, username
        case count = "_count"
    }
}

struct ConnectBody: Encodable {
    let provider: String
    let token: String
    let baseUrl: String?
}

struct RepositoriesResponse: Decodable {
    let repositories: [Repository]
}

struct Repository: Codable, Identifiable {
    struct ConnectionInfo: Codable {
        let provider: String
        let username: String
    }

    let id: String
    let connectionId: String
    let externalId: String?
    let name: String
    let fullName: String
    let cloneUrl: String?
    let defaultBranch: String?
    let autoPropose: Bool?
    let autoCreatePr: Bool?
    let autoReviewPr: Bool?
    let autoMergePr: Bool?
    let llmConfigId: String?
    let connection: ConnectionInfo?
}

struct TasksResponse: Decodable {
    let tasks: [AgentTask]
}

struct TaskResponse: Decodable {
    let task: AgentTask
}

struct CreateTaskBody: Encodable {
    let repositoryId: String
    let prompt: String
}

struct AgentTask: Decodable, Identifiable {
    let id: String
    let repositoryId: String
    let kind: String?
    let title: String?
    let prompt: String?
    let status: String
    let branchName: String?
    let prUrl: String?
    let llmConfigId: String?
    let thinkingLevel: String?
    let error: String?
    let createdAt: String?
    let updatedAt: String?

    var isRunning: Bool {
        status == "queued" || status == "running"
    }
}

struct LlmConfigsResponse: Decodable {
    let configs: [LlmConfig]
}

struct LlmConfig: Decodable, Identifiable {
    let id: String
    let name: String
    let baseUrl: String
    let hasApiKey: Bool?
    let model: String
    let thinkingLevel: String?
    let temperature: Double?
    let maxTokens: Int?
    let contextWindow: Int?
    let systemPromptExtra: String?
    let timeoutSeconds: Int?
    let maxRetries: Int?
    let requestsPerMinute: Int?
    let maxTokensPerRun: Int?
    let customHeaders: [String: String]?
    let isDefault: Bool?
    let enabled: Bool?
}

/// Payload for creating/updating/testing an LLM config. Nil optionals are
/// omitted from the encoded JSON (synthesized encodeIfPresent), so an empty
/// apiKey on edit leaves the stored key untouched.
struct LlmConfigPayload: Encodable {
    var name: String
    var baseUrl: String
    var model: String
    var apiKey: String?
    var thinkingLevel: String
    var temperature: Double
    var maxTokens: Int
    var contextWindow: Int
    var systemPromptExtra: String?
    var timeoutSeconds: Int
    var maxRetries: Int
    var requestsPerMinute: Int
    var maxTokensPerRun: Int?
    var customHeaders: [String: String]
    var isDefault: Bool
    var enabled: Bool
}

struct LlmTestResult: Decodable {
    let ok: Bool
    let latencyMs: Int?
    let modelEcho: String?
    let reply: String?
    let error: String?
}
