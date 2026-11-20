import Foundation
import Observation

/// One result of the speech model: `isFinal` text is settled, the rest is replaced by the next result.
struct SpeechHeard: Equatable, Sendable {
    let text: String
    let isFinal: Bool
}

/// Why listening stopped before the user ended it, as a code for logs and a message for the sheet.
enum SpeechFailure: Error, Equatable {
    case microphoneDenied
    case unsupported
    case failed

    var code: String {
        switch self {
        case .microphoneDenied: "E_TRANSCRIBE_MIC_DENIED"
        case .unsupported: "E_TRANSCRIBE_UNSUPPORTED"
        case .failed: "E_TRANSCRIBE_FAILED"
        }
    }

    var message: String {
        switch self {
        case .microphoneDenied: L10n.phoneTranscribeMicDenied()
        case .unsupported: L10n.phoneTranscribeUnsupported()
        case .failed: L10n.phoneTranscribeFailed()
        }
    }
}

/// The system's speech model, behind a seam so tests drive the sheet without a microphone.
@MainActor
protocol SpeechListening: AnyObject {
    /// Ends a session already running, then returns once the microphone is heard; `downloading`
    /// says the language's model is being fetched first.
    func start(
        locale: Locale, downloading: @escaping @MainActor @Sendable () -> Void,
        heard: @escaping @MainActor @Sendable (SpeechHeard) -> Void
    ) async throws
    /// Stops the microphone and returns once every result of what was heard has come.
    func finish() async
    /// Stops at once; results still on their way are dropped.
    func cancel() async
}

/// The languages Devot transcribes, each by the system's on-device model.
enum TranscriptionLanguage: String, CaseIterable, Sendable {
    case english
    case chinese

    static let storeKey = "devot.transcribe.language"

    var locale: Locale {
        switch self {
        case .english:
            Locale.current.language.languageCode == .english ? Locale.current : Locale(identifier: "en-US")
        case .chinese: Locale(identifier: "zh-CN")
        }
    }

    var name: String {
        switch self {
        case .english: L10n.phoneTranscribeEnglish()
        case .chinese: L10n.phoneTranscribeChinese()
        }
    }

    /// The language picked last, else the one the app is shown in.
    static func preferred(stored: String?, appLanguage: String?) -> TranscriptionLanguage {
        if let stored, let picked = TranscriptionLanguage(rawValue: stored) { return picked }
        return appLanguage?.hasPrefix("zh") == true ? .chinese : .english
    }
}

/// Joins transcript pieces: a space between two words of a spaced script, none beside Chinese
/// text or where a piece already has one.
enum Transcript {
    static func join(_ head: String, _ tail: String) -> String {
        guard let last = head.last, let first = tail.first else { return head + tail }
        if last.isWhitespace || first.isWhitespace || unspaced(last) || unspaced(first) { return head + tail }
        return head + " " + tail
    }

    /// Pieces of at most `limit` characters, cut at a line or space where one is near the end.
    static func chunks(_ text: String, limit: Int) -> [String] {
        var rest = Substring(text)
        var out: [String] = []
        while rest.count > limit {
            let end = rest.index(rest.startIndex, offsetBy: limit)
            let window = rest[..<end]
            let cut = window.lastIndex(where: \.isWhitespace).map { rest.index(after: $0) } ?? end
            out.append(String(rest[..<cut]))
            rest = rest[cut...]
        }
        if !rest.isEmpty { out.append(String(rest)) }
        return out
    }

    private static func unspaced(_ character: Character) -> Bool {
        character.unicodeScalars.contains { scalar in
            switch scalar.value {
            case 0x3000...0x303F, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xF900...0xFAFF, 0xFF00...0xFFEF, 0x20000...0x3134F:
                true
            default: false
            }
        }
    }
}

/// Where a transcription is (docs/specs/iphone-screens.md, Scan and transcribe).
enum TranscriptionPhase: Equatable {
    case preparing
    case downloading
    case listening
    case finishing
    /// Listening ended on its own; what was heard is kept and can still be inserted.
    case stopped(SpeechFailure)
    case ended
}

/// The transcription sheet's state: one phase changed here only, and each listening session's
/// answers checked against the turn that started it, so a language switched mid-start or a
/// cancel drops what the session before still sends.
@MainActor
@Observable
final class TranscriptionModel {
    private(set) var phase: TranscriptionPhase = .preparing
    private(set) var settled = ""
    private(set) var pending = ""
    private(set) var language: TranscriptionLanguage
    @ObservationIgnored private let listener: SpeechListening
    @ObservationIgnored private let remember: (TranscriptionLanguage) -> Void
    @ObservationIgnored private var turn = 0

    init(
        listener: SpeechListening, language: TranscriptionLanguage,
        remember: @escaping (TranscriptionLanguage) -> Void = { _ in }
    ) {
        self.listener = listener
        self.language = language
        self.remember = remember
    }

    var text: String { Transcript.join(settled, pending) }
    var canInsert: Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return phase != .finishing && phase != .ended
    }

    func start() {
        guard phase == .preparing, turn == 0 else { return }
        listen()
    }

    /// Ends the session in the old language, keeping its words, and listens in the new one.
    func choose(_ next: TranscriptionLanguage) {
        guard next != language, phase != .finishing, phase != .ended else { return }
        language = next
        remember(next)
        keepPending()
        listen()
    }

    /// Hands over what was heard, all of it, once the model has settled the last words.
    func finish(_ done: @escaping @MainActor (String) -> Void) {
        guard canInsert else { return }
        let asked = turn
        if case .stopped = phase {
            return end(done)
        }
        phase = .finishing
        let listener = listener
        Task {
            await listener.finish()
            guard asked == turn else { return }
            end(done)
        }
    }

    func cancel() {
        turn += 1
        phase = .ended
        let listener = listener
        Task { await listener.cancel() }
    }

    private func end(_ done: @MainActor (String) -> Void) {
        keepPending()
        turn += 1
        phase = .ended
        done(settled.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func listen() {
        turn += 1
        let asked = turn
        phase = .preparing
        let locale = language.locale
        let listener = listener
        Task {
            do {
                try await listener.start(
                    locale: locale,
                    downloading: { [weak self] in
                        guard let self, asked == turn, phase == .preparing else { return }
                        phase = .downloading
                    },
                    heard: { [weak self] heard in self?.take(heard, asked) })
                guard asked == turn, phase == .preparing || phase == .downloading else { return }
                phase = .listening
            } catch {
                guard asked == turn else { return }
                keepPending()
                phase = .stopped((error as? SpeechFailure) ?? .failed)
            }
        }
    }

    private func take(_ heard: SpeechHeard, _ asked: Int) {
        guard asked == turn else { return }
        if heard.isFinal {
            settled = Transcript.join(settled, heard.text)
            pending = ""
        } else {
            pending = heard.text
        }
    }

    private func keepPending() {
        settled = Transcript.join(settled, pending)
        pending = ""
    }
}
