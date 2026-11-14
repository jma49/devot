import DevotShareInbox
import Foundation

/// Turns the Share Extension's inbox into notes while the app is in front: one share at a time,
/// through the page's `share.capture`, which makes the note as quick capture does. A share's
/// file goes only once its note is made; any failure keeps it for the next time
/// (docs/specs/share-extension.md).
@MainActor
final class ShareDrain {
    private let inbox: ShareInbox?
    private let locked: () -> Bool
    private let send: (Op, [String: JSONValue], @escaping (Outcome) -> Void) -> Void
    private let log: (LogLevel, String) -> Void
    private(set) var running = false
    private var again = false

    init(
        inbox: ShareInbox?, locked: @escaping () -> Bool,
        send: @escaping (Op, [String: JSONValue], @escaping (Outcome) -> Void) -> Void,
        log: @escaping (LogLevel, String) -> Void
    ) {
        self.inbox = inbox
        self.locked = locked
        self.send = send
        self.log = log
    }

    /// Starts a pass, or asks the running one for another once it ends.
    func drain() {
        guard let inbox else { return }
        if running {
            again = true
            return
        }
        inbox.sweep()
        let files = inbox.pending()
        guard !files.isEmpty else { return }
        if locked() {
            log(.info, "I_SHARE_DRAIN_LOCKED count=\(files.count)")
            return
        }
        running = true
        next(files[...], inbox)
    }

    private func next(_ files: ArraySlice<URL>, _ inbox: ShareInbox) {
        guard let file = files.first else { return finish() }
        let rest = files.dropFirst()
        let item: ShareItem
        do {
            item = try inbox.read(file)
        } catch {
            log(.warn, "W_SHARE_DRAIN_FAILED code=\(error.code)")
            return next(rest, inbox)
        }
        send(.shareCapture, Self.arguments(item)) { [weak self] outcome in
            guard let self else { return }
            switch outcome {
            case .ok(let result):
                inbox.remove(file)
                for code in result["refused"]?.array?.compactMap(\.string) ?? [] {
                    log(.warn, "W_SHARE_IMAGE_REFUSED code=\(code)")
                }
                next(rest, inbox)
            case .failed(let code):
                log(.warn, "W_SHARE_DRAIN_FAILED code=\(code)")
                if code == ProGate.required { return finish() }
                next(rest, inbox)
            }
        }
    }

    private func finish() {
        running = false
        if again {
            again = false
            drain()
        }
    }

    /// The request's arguments: the file's fields without its version, images in base64.
    static func arguments(_ item: ShareItem) -> [String: JSONValue] {
        var args: [String: JSONValue] = [
            "id": .string(item.id),
            "title": .string(item.title),
            "text": .string(item.text),
            "images": .array(item.images.map {
                .object(["name": .string($0.name), "data": .string($0.data.base64EncodedString())])
            }),
        ]
        if let url = item.url { args["url"] = .string(url) }
        return args
    }
}
