#if DEBUG
import Foundation
import UIKit

/// The spikes of docs/specs/iphone-screens.md (Spikes), by the value of `-DevotSpike`.
enum Spike: String, CaseIterable, Sendable {
    case reparenting = "S1"
    case keyboard = "S2"
    case bridge = "S3"
    case scroller = "S4"
    case barTint

    static let argument = "DevotSpike"

    enum Request: Equatable {
        case notAsked
        case asked(Spike)
        case unknown
    }

    static func asked(in defaults: UserDefaults) -> Request {
        guard let name = defaults.string(forKey: argument) else { return .notAsked }
        return Spike(rawValue: name).map(Request.asked) ?? .unknown
    }
}

/// What a spike measured; `pass` is nil when the result is read off a screenshot.
protocol SpikeResults: Encodable, Sendable {
    var pass: Bool? { get }
    var notes: [String] { get }
}

struct SpikeEnvironment: Equatable, Sendable {
    /// The model identifier (`iPhone17,1`), never the name the owner gave the phone.
    let device: String
    let os: String
    let build: String

    @MainActor static var current: SpikeEnvironment {
        var system = utsname()
        uname(&system)
        let machine = Mirror(reflecting: system.machine).children
            .compactMap { $0.value as? CChar }
            .prefix { $0 != 0 }
            .map { UInt8(bitPattern: $0) }
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "unknown"
        let bundle = info["CFBundleVersion"] as? String ?? "unknown"
        return SpikeEnvironment(
            device: String(decoding: machine, as: UTF8.self),
            os: "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)",
            build: "\(version) (\(bundle))")
    }
}

/// One run's file, `{ spike, device, os, build, startedAt, results, pass, notes }`.
struct SpikeReport: Encodable {
    let spike: Spike
    let environment: SpikeEnvironment
    let startedAt: Date
    let results: any SpikeResults

    private enum Keys: String, CodingKey {
        case spike, device, os, build, startedAt, results, pass, notes
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(spike.rawValue, forKey: .spike)
        try container.encode(environment.device, forKey: .device)
        try container.encode(environment.os, forKey: .os)
        try container.encode(environment.build, forKey: .build)
        let time = ISO8601DateFormatter()
        time.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        try container.encode(time.string(from: startedAt), forKey: .startedAt)
        try container.encode(results, forKey: .results)
        if let pass = results.pass {
            try container.encode(pass, forKey: .pass)
        } else {
            try container.encodeNil(forKey: .pass)
        }
        try container.encode(results.notes, forKey: .notes)
    }

    func json() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

enum SpikeStats {
    /// The nearest-rank percentile, as spikes.ts takes it.
    static func percentile(_ values: [Double], _ p: Double) -> Double? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        let rank = Int((p / 100 * Double(sorted.count)).rounded(.up))
        return sorted[min(sorted.count, max(1, rank)) - 1]
    }

    static func rounded(_ ms: Double) -> Double { (ms * 100).rounded() / 100 }
}

struct Timings: Codable, Equatable, Sendable {
    let count: Int
    let failed: Int
    let p50Ms: Double
    let p95Ms: Double
    let maxMs: Double

    init(count: Int, failed: Int, p50Ms: Double, p95Ms: Double, maxMs: Double) {
        self.count = count
        self.failed = failed
        self.p50Ms = p50Ms
        self.p95Ms = p95Ms
        self.maxMs = maxMs
    }

    init(ms: [Double], failed: Int) {
        let at = { (p: Double) in SpikeStats.rounded(SpikeStats.percentile(ms, p) ?? 0) }
        self.init(count: ms.count, failed: failed, p50Ms: at(50), p95Ms: at(95), maxMs: at(100))
    }
}

struct FailedRun: SpikeResults {
    let code: String
    var pass: Bool? { false }
    var notes: [String] { [code] }
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode([String: String]())
    }
}

// MARK: S1

/// spikes.ts `startWatch`.
struct PageWatch: Codable, Sendable {
    struct Pings: Codable, Sendable {
        let sent: Int
        let answered: Int
        let missed: Int
        let maxGapMs: Double
    }
    struct Viewport: Codable, Sendable {
        let resizes: Int
        let width: Double
        let height: Double
    }
    struct Sync: Codable, Sendable {
        let enabled: Bool
        let states: [String]
    }
    let hidden: Int
    let pings: Pings
    let viewport: Viewport
    let sync: Sync
}

struct ReparentingResults: SpikeResults {
    static let noSyncNote = "no sync ran during the moves: turn sync on and write on another device while it runs"

    let moves: Int
    /// Checks after a move that found the web view at another size than at the start.
    let sizeChanges: Int
    let page: PageWatch

    var pass: Bool? {
        sizeChanges == 0 && page.hidden == 0 && page.pings.missed == 0 && page.viewport.resizes == 0
    }
    var notes: [String] { page.sync.states.contains("syncing") ? [] : [Self.noSyncNote] }
}

// MARK: S2

/// spikes.ts `s2Focus` and `s2State`.
struct PageFocus: Codable, Sendable {
    let focused: Bool
    let caret: Bool
}

struct KeyboardTry: Codable, Sendable {
    let keyboardUp: Bool
    /// The keyboard went down at some point during the try, even if it came back.
    let keyboardDropped: Bool
    let fieldFirstResponder: Bool
    let webViewFirstResponder: Bool
    let page: PageFocus

    var works: Bool {
        keyboardUp && !keyboardDropped && !fieldFirstResponder && webViewFirstResponder && page.focused
            && page.caret
    }
}

struct KeyboardResults: SpikeResults {
    static let noHandOffNote = "no public hand-off kept the keyboard: choose between a guarded private path and caretOnly"

    /// The hidden field became first responder and brought the keyboard up.
    let nativeField: Bool
    /// (c): the field holds the keyboard, then the page focuses its editor.
    let handOff: KeyboardTry
    /// (c), then the web view is made first responder.
    let handOffThenWebView: KeyboardTry
    /// (b): the page focuses its editor with no keyboard up.
    let caretOnly: KeyboardTry

    var pass: Bool? { handOff.works || handOffThenWebView.works }
    var notes: [String] { pass == true ? [] : [Self.noHandOffNote] }
}

// MARK: S3

/// spikes.ts `frameStats`.
struct PageFrames: Codable, Sendable {
    let frames: Int
    let budgetMs: Double
    let medianMs: Double
    let p95Ms: Double
    let maxMs: Double
    let overBudget: Int
}

struct BridgeResults: SpikeResults {
    static let hitchesNote = "Instruments' Hitches on the device is the authority for dropped frames; it is read by hand"
    static let unsupportedExcerptsNote = "the page refuses excerpts until they get a handler, so the calls time the bridge, not the core"

    let pings: Timings
    let excerpts: Timings
    let excerptCodes: [String]
    let scroll: PageFrames

    var pass: Bool? {
        pings.failed == 0 && pings.count > 0 && pings.p50Ms <= 4 && pings.p95Ms <= 10
            && scroll.overBudget == 0
    }
    var notes: [String] {
        [Self.hitchesNote]
            + (excerptCodes.contains("E_SCREENS_OP_UNSUPPORTED") ? [Self.unsupportedExcerptsNote] : [])
    }
}

// MARK: S4

/// spikes.ts `s4Measure`.
struct PageLayout: Codable, Sendable {
    let documentHeight: Double
    let editorHeight: Double
    let lines: Int
    let renderedLines: Int
}

/// spikes.ts `s4Probe`.
struct PageScroll: Codable, Sendable {
    let scrollY: Double
    /// The middle of the screen shows a line of the note, not a gap CodeMirror has not drawn.
    let rendered: Bool
}

struct ScrollViewMeasure: Codable, Sendable {
    let contentHeight: Double
    let boundsHeight: Double
    let scrollEnabled: Bool
    let keyboardDismissInteractive: Bool
    let edgeEffectSet: Bool
}

struct ScrollProbe: Codable, Sendable {
    /// The scroll view's content offset after Swift scrolled it.
    let offset: Double
    let page: PageScroll
}

struct ScrollerResults: SpikeResults {
    static let screenshotNote = "selection handles and the bar's scroll-edge effect are read off a screenshot of the screen left up"

    let scrollView: ScrollViewMeasure
    let page: PageLayout
    let middle: ScrollProbe
    let end: ScrollProbe

    /// At the end the page and the scroll view may stop apart by the bars' insets, so only the
    /// middle has to agree.
    var pass: Bool? {
        scrollView.scrollEnabled && scrollView.contentHeight > scrollView.boundsHeight
            && abs(scrollView.contentHeight - page.documentHeight) <= 2
            && abs(middle.offset - middle.page.scrollY) <= 2 && middle.page.rendered && end.page.rendered
    }
    var notes: [String] { [Self.screenshotNote] }
}

// MARK: Bar tint

struct BarTintResults: SpikeResults {
    static let screenshotNote = "a screenshot of the screen left up shows which floating bars draw the tint"

    struct Applied: Codable, Sendable {
        let navigationBar: Bool
        let toolbar: Bool
        let tabBar: Bool
    }

    let colour = "phoneActionTrash"
    let alpha = 0.5
    let applied: Applied

    init(navigationBar: Bool, toolbar: Bool, tabBar: Bool) {
        applied = Applied(navigationBar: navigationBar, toolbar: toolbar, tabBar: tabBar)
    }

    private enum CodingKeys: String, CodingKey { case colour, alpha, applied }

    var pass: Bool? { nil }
    var notes: [String] { [Self.screenshotNote] }
}
#endif
