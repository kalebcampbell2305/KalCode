import AVFoundation
import Foundation
import Speech

/// On-device speech capture for KalVoice (SFSpeechRecognizer + AVAudioEngine).
/// The transcript is sent to the workstation as text; audio never leaves the device.
@MainActor
@Observable
final class VoiceCapture {
    enum Phase: Equatable {
        case idle
        case preparing
        case listening
        case unavailable(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var transcript = ""
    /// 0…1 input level for the listening glow.
    private(set) var level: Double = 0

    @ObservationIgnored private let recognizer: SFSpeechRecognizer? = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?

    var isListening: Bool { phase == .listening }

    func start() async {
        guard phase == .idle || phase != .listening else { return }
        transcript = ""
        phase = .preparing
        guard let recognizer else {
            phase = .unavailable("Speech recognition isn't available for your language on this device. Type a command instead.")
            return
        }
        let speech = await Self.requestSpeechAuthorization()
        guard speech == .authorized else {
            phase = .unavailable(speech == .restricted
                ? "Speech recognition is restricted on this device. Type a command instead."
                : "KalVoice needs Speech Recognition. Turn it on in Settings → KalCode Remote, or type a command.")
            return
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            phase = .unavailable("KalVoice needs the microphone. Turn it on in Settings → KalCode Remote, or type a command.")
            return
        }
        guard recognizer.isAvailable else {
            phase = .unavailable("Speech isn't available right now. Type a command instead.")
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let engine = AVAudioEngine()
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.addsPunctuation = true
            if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.channelCount > 0, format.sampleRate > 0 else {
                phase = .unavailable("No microphone is available. Type a command instead.")
                return
            }
            Self.installTap(on: input, format: format, request: request) { [weak self] level in
                Task { @MainActor in self?.level = level }
            }
            engine.prepare()
            try engine.start()
            self.engine = engine
            self.request = request
            task = Self.recognize(recognizer, request: request) { [weak self] text, finished in
                Task { @MainActor in
                    guard let self else { return }
                    if let text { self.transcript = text }
                    if finished && self.phase == .listening { self.teardown() }
                }
            }
            phase = .listening
        } catch {
            teardown()
            phase = .unavailable("Speech isn't available right now. Type a command instead.")
        }
    }

    /// Stops listening and returns the final transcript.
    func stop() async -> String {
        guard phase == .listening else { return transcript }
        request?.endAudio()
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        // Give the recognizer a moment to deliver its final result.
        try? await Task.sleep(nanoseconds: 450_000_000)
        let text = transcript
        teardown()
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func cancel() {
        teardown()
        transcript = ""
    }

    func resetAvailability() {
        if case .unavailable = phase { phase = .idle }
    }

    private func teardown() {
        task?.cancel()
        task = nil
        if let engine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        engine = nil
        request = nil
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if phase == .listening || phase == .preparing { phase = .idle }
    }

    // Callbacks run on audio / recognizer threads, so they are built outside the main actor.

    nonisolated private static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
    }

    nonisolated private static func installTap(on input: AVAudioInputNode, format: AVAudioFormat,
                                               request: SFSpeechAudioBufferRecognitionRequest,
                                               level: @escaping @Sendable (Double) -> Void) {
        var counter = 0
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
            counter += 1
            guard counter % 4 == 0, let data = buffer.floatChannelData?[0] else { return }
            let n = Int(buffer.frameLength)
            guard n > 0 else { return }
            var sum: Float = 0
            for i in stride(from: 0, to: n, by: 8) { sum += data[i] * data[i] }
            let rms = sqrt(sum / Float(max(n / 8, 1)))
            level(Double(min(1, rms * 12)))
        }
    }

    nonisolated private static func recognize(_ recognizer: SFSpeechRecognizer, request: SFSpeechAudioBufferRecognitionRequest,
                                              update: @escaping @Sendable (String?, Bool) -> Void) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            update(result?.bestTranscription.formattedString, (result?.isFinal ?? false) || error != nil)
        }
    }
}
