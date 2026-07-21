import AVFoundation
import Speech

/// Wraps SFSpeechRecognizer + AVAudioEngine for live transcription.
/// Callbacks are always delivered on the main actor.
@MainActor
final class SpeechRecognizer {
    enum SpeechError: LocalizedError {
        case recognizerUnavailable

        var errorDescription: String? {
            switch self {
            case .recognizerUnavailable:
                return "Speech recognition is not available on this device."
            }
        }
    }

    var onTranscript: ((String) -> Void)?
    var onFinished: (() -> Void)?

    private let recognizer = SFSpeechRecognizer()
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?

    /// Asks for speech recognition and microphone permission.
    func requestPermissions() async -> Bool {
        let speechGranted = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
        guard speechGranted else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }

    func start() throws {
        stop()
        guard let recognizer, recognizer.isAvailable else {
            throw SpeechError.recognizerUnavailable
        }
        try configureAudioSession()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.request = request
        installTap(on: request)
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                self?.handleResult(result, error: error)
            }
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        guard request != nil || recognitionTask != nil else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        recognitionTask?.cancel()
        request = nil
        recognitionTask = nil
    }

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    private func installTap(on request: SFSpeechAudioBufferRecognitionRequest) {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
    }

    private func handleResult(_ result: SFSpeechRecognitionResult?, error: (any Error)?) {
        if let result {
            onTranscript?(result.bestTranscription.formattedString)
        }
        guard error != nil || (result?.isFinal ?? false) else { return }
        stop()
        onFinished?()
    }
}
