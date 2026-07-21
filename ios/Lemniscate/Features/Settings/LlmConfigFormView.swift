import SwiftUI

struct LlmConfigFormView: View {
    enum Mode {
        case add
        case edit(LlmConfig)
    }

    let mode: Mode
    let onSaved: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var form: LlmConfigFormState
    @State private var isSaving = false
    @State private var isTesting = false
    @State private var testResult: LlmTestResult?
    @State private var errorMessage: String?

    init(mode: Mode, onSaved: @escaping () async -> Void) {
        self.mode = mode
        self.onSaved = onSaved
        switch mode {
        case .add:
            _form = State(initialValue: LlmConfigFormState())
        case .edit(let config):
            _form = State(initialValue: LlmConfigFormState(config: config))
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                connectionSection
                generationSection
                reliabilitySection
                optionsSection
                testSection
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(isSaving || isTesting)
                }
            }
            .errorAlert($errorMessage)
        }
    }

    private var title: String {
        if case .add = mode { return "New LLM config" }
        return "Edit LLM config"
    }

    private var connectionSection: some View {
        Section("Connection") {
            TextField("Name", text: $form.name)
            TextField("Base URL", text: $form.baseUrl)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            SecureField(apiKeyPlaceholder, text: $form.apiKey)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Model", text: $form.model)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
    }

    private var apiKeyPlaceholder: String {
        form.hasStoredApiKey ? "API key (leave empty to keep)" : "API key"
    }

    private var generationSection: some View {
        Section("Generation") {
            Picker("Thinking level", selection: $form.thinkingLevel) {
                ForEach(LlmConfigFormState.thinkingLevels, id: \.self) {
                    Text($0).tag($0)
                }
            }
            TextField("Temperature", text: $form.temperature)
                .keyboardType(.decimalPad)
            TextField("Max tokens", text: $form.maxTokens)
                .keyboardType(.numberPad)
            TextField("Context window", text: $form.contextWindow)
                .keyboardType(.numberPad)
            TextField("Extra system prompt (optional)", text: $form.systemPromptExtra, axis: .vertical)
                .lineLimit(2...4)
        }
    }

    private var reliabilitySection: some View {
        Section("Reliability & limits") {
            TextField("Timeout (seconds)", text: $form.timeoutSeconds)
                .keyboardType(.numberPad)
            TextField("Max retries", text: $form.maxRetries)
                .keyboardType(.numberPad)
            TextField("Requests per minute", text: $form.requestsPerMinute)
                .keyboardType(.numberPad)
            TextField("Max tokens per run (optional)", text: $form.maxTokensPerRun)
                .keyboardType(.numberPad)
            TextField("Custom headers (JSON, optional)", text: $form.customHeadersJSON, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .lineLimit(1...3)
        }
    }

    private var optionsSection: some View {
        Section("Options") {
            Toggle("Default config", isOn: $form.isDefault)
            Toggle("Enabled", isOn: $form.enabled)
        }
    }

    private var testSection: some View {
        Section {
            Button { testConnection() } label: {
                HStack {
                    if isTesting {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text("Test connection")
                }
            }
            .disabled(isTesting || isSaving)
            if let testResult {
                Text(testMessage(testResult))
                    .font(.caption)
                    .foregroundStyle(testResult.ok ? Color.green : Color.red)
            }
        }
    }

    private func testMessage(_ result: LlmTestResult) -> String {
        guard result.ok else {
            return "Failed: \(result.error ?? "unknown error")"
        }
        let latency = result.latencyMs.map { "\($0) ms" } ?? "?"
        let echo = result.modelEcho.map { " · \($0)" } ?? ""
        return "OK · \(latency)\(echo)"
    }

    private func save() {
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                try await performSave()
                await onSaved()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func performSave() async throws {
        switch mode {
        case .add:
            let payload = try form.payload(requireApiKey: true)
            try await APIClient.shared.send("POST", "api/llm-configs", body: payload)
        case .edit(let config):
            let payload = try form.payload(requireApiKey: false)
            try await APIClient.shared.send("PATCH", "api/llm-configs/\(config.id)", body: payload)
        }
    }

    private func testConnection() {
        isTesting = true
        testResult = nil
        Task {
            defer { isTesting = false }
            do {
                testResult = try await performTest()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Uses the saved-config endpoint when editing without re-entering the
    /// API key (the server keeps the stored key); otherwise tests the
    /// unsaved payload, which requires the key.
    private func performTest() async throws -> LlmTestResult {
        let keyEmpty = form.apiKey.trimmingCharacters(in: .whitespaces).isEmpty
        if case .edit(let config) = mode, keyEmpty {
            return try await APIClient.shared.request("POST", "api/llm-configs/\(config.id)/test")
        }
        let payload = try form.payload(requireApiKey: true)
        return try await APIClient.shared.request("POST", "api/llm-configs/test", body: payload)
    }
}
