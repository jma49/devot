import UIKit

/// The synced Animations choice (`animations`) against the system's Reduce Motion.
struct MotionPolicy: Equatable {
    enum Choice: String {
        case always, system, off
    }

    let choice: Choice

    init(animations: String?) {
        choice = animations.flatMap(Choice.init(rawValue:)) ?? .system
    }

    init(editor: [String: JSONValue]) {
        self.init(animations: editor["animations"]?.string)
    }

    func reduced(systemReduceMotion: Bool) -> Bool {
        switch choice {
        case .always: false
        case .system: systemReduceMotion
        case .off: true
        }
    }

    @MainActor var reduced: Bool { reduced(systemReduceMotion: UIAccessibility.isReduceMotionEnabled) }
}
