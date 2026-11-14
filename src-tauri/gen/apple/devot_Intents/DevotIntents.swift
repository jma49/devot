import AppIntents
import DevotShareInbox
import Foundation
import os

// The Shortcuts actions (docs/specs/share-extension.md, Shortcuts). They run in this extension, not
// the app: Add to Devot leaves its note in the inbox the app drains, so a Shortcut never starts
// the app, its database or its key in the background.
@main
struct DevotIntentsExtension: AppIntentsExtension {}

struct AddToDevotIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.add.title"
    static let description = IntentDescription("intent.add.description")

    @Parameter(title: "intent.field.text", inputOptions: String.IntentInputOptions(multiline: true))
    var text: String?

    @Parameter(title: "intent.field.title")
    var noteTitle: String?

    @Parameter(title: "intent.field.link")
    var link: URL?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let inbox = ShareInbox.shared() else { throw AddFailure(code: "E_SHARE_INBOX_UNAVAILABLE") }
        do {
            try inbox.add(title: noteTitle ?? "", text: text ?? "", url: link?.absoluteString)
        } catch {
            throw AddFailure(code: error.code)
        }
        return .result(dialog: IntentDialog("intent.added"))
    }
}

struct OpenTodayIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.today.title"
    static let description = IntentDescription("intent.today.description")

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(URL(string: "devot://today")!))
    }
}

struct DevotShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddToDevotIntent(), phrases: ["Add to \(.applicationName)"],
            shortTitle: "intent.add.title", systemImageName: "square.and.pencil")
        AppShortcut(
            intent: OpenTodayIntent(), phrases: ["Open today's note in \(.applicationName)"],
            shortTitle: "intent.today.title", systemImageName: "calendar")
    }
}

struct AddFailure: Error, CustomLocalizedStringResourceConvertible {
    private static let log = Logger(subsystem: "io.github.jma49.devot", category: "intents")
    let code: String

    init(code: String) {
        self.code = code
        Self.log.warning("W_INTENT_ADD_FAILED code=\(code, privacy: .public)")
    }

    var localizedStringResource: LocalizedStringResource {
        switch code {
        case "E_SHARE_EMPTY": "intent.error.empty"
        case "E_SHARE_URL_INVALID": "intent.error.link"
        case "E_SHARE_TITLE_TOO_LONG", "E_SHARE_TEXT_TOO_LONG", "E_SHARE_TOO_LARGE": "intent.error.tooLarge"
        case "E_SHARE_INBOX_FULL": "intent.error.full"
        default: "intent.error.save"
        }
    }
}
