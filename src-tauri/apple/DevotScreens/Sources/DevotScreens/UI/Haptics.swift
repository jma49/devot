import UIKit

/// The generators Devot's own haptics play (design/motion.md, Haptics). A generator that fires has
/// been `prepare()`d first, so the tick lands with the change it marks.
enum HapticKind: CaseIterable, Sendable {
    case selection, light, warning, success, error
}

/// What happened that deserves a tick. The system's controls (swipe actions, menus, switches, the
/// tab bar, sheets) play their own, and a push, pop, tab switch or sheet rise plays none.
enum HapticEvent: CaseIterable, Sendable {
    case statusChange, pickerChoice, tabReselect
    case pinToggled, listAction, undoableTrash
    case gateSheet
    case purchaseRestored, purchaseFailed

    var kind: HapticKind {
        switch self {
        case .statusChange, .pickerChoice, .tabReselect: .selection
        case .pinToggled, .listAction, .undoableTrash: .light
        case .gateSheet: .warning
        case .purchaseRestored: .success
        case .purchaseFailed: .error
        }
    }

    /// The tick a list write makes when the user picked it from a menu or the selection bar.
    init?(_ change: NoteChange) {
        switch change {
        case .pinned: self = .pinToggled
        case .status: self = .statusChange
        case .trash: self = .undoableTrash
        case .book, .putTag, .removeTag, .restore: self = .listAction
        case .purge: return nil
        }
    }
}

@MainActor
protocol HapticGenerator {
    func prepare()
    func occurred()
}

/// One UIKit generator, anchored to a view so the system knows which scene feels it.
@MainActor
struct SystemHaptic: HapticGenerator {
    let feedback: UIFeedbackGenerator
    private let fire: () -> Void

    init(_ kind: HapticKind, view: UIView?) {
        switch kind {
        case .selection:
            let generator = view.map { UISelectionFeedbackGenerator(view: $0) } ?? UISelectionFeedbackGenerator()
            feedback = generator
            fire = { generator.selectionChanged() }
        case .light:
            let generator =
                view.map { UIImpactFeedbackGenerator(style: .light, view: $0) } ?? UIImpactFeedbackGenerator(style: .light)
            feedback = generator
            fire = { generator.impactOccurred() }
        case .warning, .success, .error:
            let generator = view.map { UINotificationFeedbackGenerator(view: $0) } ?? UINotificationFeedbackGenerator()
            let type: UINotificationFeedbackGenerator.FeedbackType =
                kind == .warning ? .warning : kind == .success ? .success : .error
            feedback = generator
            fire = { generator.notificationOccurred(type) }
        }
    }

    func prepare() { feedback.prepare() }
    func occurred() { fire() }
}

private struct Silent: HapticGenerator {
    func prepare() {}
    func occurred() {}
}

/// Devot's haptics, held for the session by `Screens` and handed to the screens that fire them.
/// A control that may fire one calls `prepare` on touch-down; `play` prepares again, which costs
/// nothing when the generator is ready already.
@MainActor
final class Haptics {
    typealias Factory = @MainActor (HapticKind) -> any HapticGenerator

    /// Replacing the factory drops the generators made so far.
    var make: Factory {
        didSet { held = [:] }
    }
    private(set) weak var view: UIView?
    private var held: [HapticKind: any HapticGenerator] = [:]

    /// Without a factory it makes no sound: a screen outside `Screens` (a test, a preview) feels nothing.
    init(make: @escaping Factory = { _ in Silent() }) {
        self.make = make
    }

    convenience init(view: UIView) {
        self.init(make: Self.system(view: view))
        self.view = view
    }

    static func system(view: UIView?) -> Factory {
        { SystemHaptic($0, view: view) }
    }

    func prepare(_ event: HapticEvent) {
        generator(event.kind).prepare()
    }

    func play(_ event: HapticEvent) {
        play(kind: event.kind)
    }

    /// One the page asks for (`editor.haptic`), by the name `haptics.ts` gives it.
    func play(page name: String) {
        switch name {
        case "light", "soft": play(kind: .light)
        case "selection": play(kind: .selection)
        case "success": play(kind: .success)
        case "warning": play(kind: .warning)
        default: return
        }
    }

    private func play(kind: HapticKind) {
        let generator = generator(kind)
        generator.prepare()
        generator.occurred()
    }

    private func generator(_ kind: HapticKind) -> any HapticGenerator {
        if let generator = held[kind] { return generator }
        let generator = make(kind)
        held[kind] = generator
        return generator
    }
}
