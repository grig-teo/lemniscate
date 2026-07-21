import Foundation

@MainActor
final class MainViewModel: ObservableObject {
    @Published var selectedRepo: Repository? {
        didSet { persistSelection() }
    }
    @Published var transcript = ""
    @Published var isRecording = false
    @Published var isSending = false
    @Published var alertMessage: String?
    @Published var showRepoPicker = false
    @Published var showSettings = false

    private let speech = SpeechRecognizer()
    private static let selectionKey = "selectedRepository"

    var micEnabled: Bool {
        selectedRepo != nil && !isSending
    }

    init() {
        selectedRepo = Self.loadSelection()
        speech.onTranscript = { [weak self] text in
            self?.transcript = text
        }
        speech.onFinished = { [weak self] in
            self?.isRecording = false
        }
    }

    func toggleMic() async {
        if isRecording {
            await stopAndSubmit()
        } else {
            await startRecording()
        }
    }

    private func startRecording() async {
        guard await speech.requestPermissions() else {
            alertMessage = "Microphone and speech recognition access are required to dictate tasks."
            return
        }
        do {
            try speech.start()
            transcript = ""
            isRecording = true
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    private func stopAndSubmit() async {
        speech.stop()
        isRecording = false
        let prompt = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        guard let repo = selectedRepo else { return }
        await submit(prompt: prompt, repositoryId: repo.id)
    }

    private func submit(prompt: String, repositoryId: String) async {
        isSending = true
        defer { isSending = false }
        do {
            let body = CreateTaskBody(repositoryId: repositoryId, prompt: prompt)
            let _: TaskResponse = try await APIClient.shared.request("POST", "api/tasks", body: body)
            transcript = ""
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    private func persistSelection() {
        guard let selectedRepo else {
            UserDefaults.standard.removeObject(forKey: Self.selectionKey)
            return
        }
        if let data = try? JSONEncoder().encode(selectedRepo) {
            UserDefaults.standard.set(data, forKey: Self.selectionKey)
        }
    }

    private static func loadSelection() -> Repository? {
        guard let data = UserDefaults.standard.data(forKey: selectionKey) else { return nil }
        return try? JSONDecoder().decode(Repository.self, from: data)
    }
}
