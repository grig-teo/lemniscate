import Foundation

struct FormError: LocalizedError {
    let message: String

    var errorDescription: String? { message }

    init(_ message: String) {
        self.message = message
    }
}

/// Editable string-backed state for the LLM config form. Converts to a typed
/// `LlmConfigPayload` with validation matching the backend schema.
struct LlmConfigFormState {
    static let thinkingLevels = ["off", "low", "medium", "high"]

    var name = ""
    var baseUrl = "https://api.openai.com/v1"
    var apiKey = ""
    var model = ""
    var thinkingLevel = "off"
    var temperature = "0.2"
    var maxTokens = "4096"
    var contextWindow = "128000"
    var systemPromptExtra = ""
    var timeoutSeconds = "120"
    var maxRetries = "3"
    var requestsPerMinute = "60"
    var maxTokensPerRun = ""
    var customHeadersJSON = ""
    var isDefault = false
    var enabled = true
    var hasStoredApiKey = false

    init() {}

    init(config: LlmConfig) {
        name = config.name
        baseUrl = config.baseUrl
        model = config.model
        thinkingLevel = config.thinkingLevel ?? "off"
        temperature = String(config.temperature ?? 0.2)
        maxTokens = config.maxTokens.map(String.init) ?? ""
        contextWindow = config.contextWindow.map(String.init) ?? ""
        systemPromptExtra = config.systemPromptExtra ?? ""
        timeoutSeconds = config.timeoutSeconds.map(String.init) ?? "120"
        maxRetries = config.maxRetries.map(String.init) ?? "3"
        requestsPerMinute = config.requestsPerMinute.map(String.init) ?? "60"
        maxTokensPerRun = config.maxTokensPerRun.map(String.init) ?? ""
        isDefault = config.isDefault ?? false
        enabled = config.enabled ?? true
        hasStoredApiKey = config.hasApiKey ?? false
        customHeadersJSON = Self.headersJSON(config.customHeaders)
    }

    func payload(requireApiKey: Bool) throws -> LlmConfigPayload {
        let cleanName = name.trimmingCharacters(in: .whitespaces)
        guard !cleanName.isEmpty else { throw FormError("Name is required") }
        let cleanBase = baseUrl.trimmingCharacters(in: .whitespaces)
        guard cleanBase.hasPrefix("http://") || cleanBase.hasPrefix("https://") else {
            throw FormError("Base URL must start with http:// or https://")
        }
        let cleanModel = model.trimmingCharacters(in: .whitespaces)
        guard !cleanModel.isEmpty else { throw FormError("Model is required") }
        let cleanKey = apiKey.trimmingCharacters(in: .whitespaces)
        if requireApiKey, cleanKey.isEmpty {
            throw FormError("API key is required")
        }
        guard let temperatureValue = Double(temperature), (0...2).contains(temperatureValue) else {
            throw FormError("Temperature must be a number between 0 and 2")
        }
        let extra = systemPromptExtra.trimmingCharacters(in: .whitespacesAndNewlines)
        return LlmConfigPayload(
            name: cleanName,
            baseUrl: cleanBase,
            model: cleanModel,
            apiKey: cleanKey.isEmpty ? nil : cleanKey,
            thinkingLevel: thinkingLevel,
            temperature: temperatureValue,
            maxTokens: try Self.int(maxTokens, "Max tokens", range: 1...Int.max),
            contextWindow: try Self.int(contextWindow, "Context window", range: 1...Int.max),
            systemPromptExtra: extra.isEmpty ? nil : extra,
            timeoutSeconds: try Self.int(timeoutSeconds, "Timeout", range: 1...600),
            maxRetries: try Self.int(maxRetries, "Max retries", range: 0...10),
            requestsPerMinute: try Self.int(requestsPerMinute, "Requests per minute", range: 1...Int.max),
            maxTokensPerRun: try optionalBudget(),
            customHeaders: try parsedHeaders(),
            isDefault: isDefault,
            enabled: enabled
        )
    }

    private func optionalBudget() throws -> Int? {
        let raw = maxTokensPerRun.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty else { return nil }
        return try Self.int(raw, "Max tokens per run", range: 1...Int.max)
    }

    private func parsedHeaders() throws -> [String: String] {
        let raw = customHeadersJSON.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return [:] }
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let headers = object as? [String: String] else {
            throw FormError("Custom headers must be a JSON object of string pairs")
        }
        return headers
    }

    private static func int(_ raw: String, _ field: String, range: ClosedRange<Int>) throws -> Int {
        guard let value = Int(raw.trimmingCharacters(in: .whitespaces)), range.contains(value) else {
            throw FormError("\(field) must be an integer in \(range.lowerBound)…\(range.upperBound)")
        }
        return value
    }

    private static func headersJSON(_ headers: [String: String]?) -> String {
        guard let headers, !headers.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: headers) else {
            return ""
        }
        return String(data: data, encoding: .utf8) ?? ""
    }
}
