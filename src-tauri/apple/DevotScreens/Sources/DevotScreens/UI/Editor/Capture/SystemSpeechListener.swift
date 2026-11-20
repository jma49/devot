import AVFoundation
import Speech

/// Speech to text by the system's on-device model (Speech's `SpeechAnalyzer` and
/// `SpeechTranscriber`): the audio never leaves the device, and the model is the system's, shared
/// with other apps and fetched once per language, so the app carries none of it.
@MainActor
final class SystemSpeechListener: SpeechListening {
    private let engine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var results: Task<Void, Never>?
    private var tapped = false
    /// Counts starts, so a start overtaken by the next one gives up before it touches the microphone.
    private var session = 0

    func start(
        locale: Locale, downloading: @escaping @MainActor @Sendable () -> Void,
        heard: @escaping @MainActor @Sendable (SpeechHeard) -> Void
    ) async throws {
        session += 1
        let mine = session
        await cancel()
        guard await AVAudioApplication.requestRecordPermission() else { throw SpeechFailure.microphoneDenied }
        guard SpeechTranscriber.isAvailable, let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale)
        else { throw SpeechFailure.unsupported }
        let transcriber = SpeechTranscriber(
            locale: supported, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
        do {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                downloading()
                try await request.downloadAndInstall()
            }
        } catch {
            throw SpeechFailure.unsupported
        }
        guard mine == session,
            let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]), mine == session
        else { throw SpeechFailure.failed }
        let analyzer = SpeechAnalyzer(modules: [transcriber], options: nil)
        let (stream, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
        self.analyzer = analyzer
        self.input = input
        let sequence = transcriber.results
        results = Task {
            do {
                for try await result in sequence {
                    heard(SpeechHeard(text: String(result.text.characters), isFinal: result.isFinal))
                }
            } catch {}
        }
        do {
            try await analyzer.start(inputSequence: stream)
            guard mine == session else { throw SpeechFailure.failed }
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audio.setActive(true)
            let node = engine.inputNode
            let heardFormat = node.outputFormat(forBus: 0)
            guard let converter = AVAudioConverter(from: heardFormat, to: format) else { throw SpeechFailure.failed }
            node.installTap(
                onBus: 0, bufferSize: 4_096, format: heardFormat,
                block: Self.tap(converter: converter, format: format, input: input))
            tapped = true
            engine.prepare()
            try engine.start()
        } catch {
            await cancel()
            throw SpeechFailure.failed
        }
    }

    func finish() async {
        stopAudio()
        input?.finish()
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        await results?.value
        clear()
    }

    func cancel() async {
        stopAudio()
        input?.finish()
        await analyzer?.cancelAndFinishNow()
        results?.cancel()
        clear()
    }

    private func stopAudio() {
        engine.stop()
        if tapped {
            engine.inputNode.removeTap(onBus: 0)
            tapped = false
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func clear() {
        analyzer = nil
        input = nil
        results = nil
    }

    /// Made outside the main actor: the engine calls the tap on its own audio thread.
    nonisolated private static func tap(
        converter: AVAudioConverter, format: AVAudioFormat, input: AsyncStream<AnalyzerInput>.Continuation
    ) -> AVAudioNodeTapBlock {
        // Only the audio thread uses these, one buffer at a time.
        nonisolated(unsafe) let converter = converter
        nonisolated(unsafe) let format = format
        return { buffer, _ in
            guard let converted = convert(buffer, converter, format) else { return }
            input.yield(AnalyzerInput(buffer: converted))
        }
    }

    nonisolated private static func convert(
        _ buffer: AVAudioPCMBuffer, _ converter: AVAudioConverter, _ format: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        if buffer.format == format { return buffer }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        nonisolated(unsafe) let source = buffer
        nonisolated(unsafe) var given = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, status in
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return source
        }
        return status == .error || error != nil ? nil : out
    }
}
