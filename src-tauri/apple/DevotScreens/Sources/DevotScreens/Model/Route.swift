/// The tabs, in the tab bar's order.
public enum Tab: String, CaseIterable, Codable, CodingKeyRepresentable, Sendable {
    case notes
    case library
    case activity
    case settings
    case search
}

/// A screen above a tab's root, named by kind and IDs only (docs/specs/iphone-screens.md, Routes).
enum ScreenRoute: Codable, Equatable, Sendable {
    /// A note list the Library opened, the Templates among them.
    case list(ListView, StatusFilter)
    case trash
    case editor(noteId: String)
    /// A Settings page, by the pane name `SettingsPage(pane:)` reads.
    case pane(String)
}

/// What a deep link shows, as Rust routed it (src-tauri/src/screens/route.rs).
enum LinkRoute: Equatable, Sendable {
    /// The tab, with these screens above its root and nothing else.
    case stack(Tab, [ScreenRoute])
    /// Today's note, which the page finds or makes, in the Notes tab's editor.
    case today
    /// Settings > License, the key filled in and never submitted.
    case licence(prefill: String?)
    /// The editor's mode, when a note is on top.
    case mode(NoteMode)

    init?(_ fields: [String: JSONValue]) {
        switch fields["route"]?.string {
        case "stack":
            guard let name = fields["tab"]?.string, let tab = Tab(rawValue: name), [.notes, .library].contains(tab),
                let screens = fields["stack"]?.array
            else { return nil }
            var stack: [ScreenRoute] = []
            for screen in screens {
                switch screen["kind"]?.string {
                case "editor":
                    guard let id = screen["noteId"]?.string else { return nil }
                    stack.append(.editor(noteId: id))
                case "trash": stack.append(.trash)
                default: return nil
                }
            }
            self = .stack(tab, stack)
        case "today": self = .today
        case "licence":
            let prefill = fields["prefill"]
            guard prefill == nil || prefill == .null || prefill?.string != nil else { return nil }
            self = .licence(prefill: prefill?.string)
        case "mode":
            guard let name = fields["mode"]?.string, let mode = NoteMode(rawValue: name) else { return nil }
            self = .mode(mode)
        default: return nil
        }
    }
}

extension ScreenRoute {
    var editorId: String? {
        if case .editor(let id) = self { id } else { nil }
    }
}
