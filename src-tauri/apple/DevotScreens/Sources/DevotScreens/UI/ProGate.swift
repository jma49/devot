import Foundation

/// A write the user asked for while the gate held it: only what they picked, never text.
enum WriteIntent: Equatable {
    case newNote(bookId: String?)
}

/// The short Pro sheet's kinds, as `requireEditing.ts` names them.
enum ProSheetKind: String, CaseIterable {
    case checking
    case key
    case attention
    case seat
    case unreadable

    /// Enter License Key and Open License Settings leave for Settings; the others check again.
    var opensLicence: Bool { self == .key || self == .attention || self == .seat }
}

/// What a locked write shows: the purchase sheet with its gate heading, or the short Pro sheet.
enum LockSurface: Equatable {
    case purchase(heading: String)
    case pro(ProSheetKind)

    /// `lockSurface` in `requireEditing.ts`, which `tests/fixtures/licence-gate.json` holds both to.
    init(_ licence: Licence) {
        let unreadable = [licence.code, licence.trial?.code].contains { code in
            code == ProGate.unreadable || code?.hasPrefix("E_LICENCE_KEYCHAIN") == true
        }
        let seatMissing =
            licence.state == "valid" && (licence.activation?.state == "required" || licence.activation?.state == "expired")
        if unreadable {
            self = .pro(.unreadable)
        } else if licence.soldOnAppStore, licence.appStore?.code != nil {
            self = .pro(.checking)
        } else if seatMissing {
            self = .pro(.seat)
        } else if licence.soldOnAppStore {
            self = .purchase(
                heading: licence.trial?.state == "available" ? L10n.phoneProInactiveTitle() : L10n.phonePurchaseEnded())
        } else if licence.state == "revoked" || licence.state == "invalid" {
            self = .pro(.attention)
        } else {
            self = .pro(.key)
        }
    }
}

/// The one gate every write the native screens start goes through (docs/specs/iphone-screens.md,
/// The gate). It decides from the licence snapshot alone, never by trying the write and never
/// waiting on the bridge. The snapshot is only the UI's guess: Rust refuses every locked write.
@MainActor
final class ProGate {
    nonisolated static let required = "E_LICENCE_REQUIRED"
    nonisolated static let unreadable = "E_LICENCE_UNREADABLE"
    /// How long a held intent may still run once the licence unlocks.
    nonisolated static let intentLifetime: TimeInterval = 10 * 60

    private struct Held {
        let intent: WriteIntent
        let at: Date
    }

    /// The snapshot; nil before the first read, which lets the write go to Rust's own gate.
    var licence: () -> Licence?
    var now: () -> Date = Date.init
    /// Shows the surface; the screens tell the gate when it went (`dismissed`).
    var present: (LockSurface) -> Void = { _ in }
    /// Closes the surface that is up; the screens then call `dismissed`.
    var dismiss: () -> Void = {}
    /// Reads the snapshot again, then calls back.
    var refresh: (@escaping () -> Void) -> Void = { $0() }
    /// The write itself, once the gate lets it.
    var perform: (WriteIntent) -> Void = { _ in }

    private var held: Held?
    private var unlockedBySheet = false
    private(set) var showing = false

    init(licence: @escaping () -> Licence?) {
        self.licence = licence
    }

    var holding: WriteIntent? { held?.intent }

    func locked() -> Bool {
        guard let licence = licence() else { return false }
        return !licence.allows(now())
    }

    /// Runs the write at once, or shows the state's surface and keeps the intent while it is up.
    func require(_ intent: WriteIntent) {
        guard locked(), let licence = licence() else { return perform(intent) }
        guard !showing else { return }
        held = Held(intent: intent, at: now())
        unlockedBySheet = false
        show(LockSurface(licence))
    }

    /// Rust refused a write the snapshot let through: the surface shows, with nothing kept.
    func refused(code: String) {
        refresh { [weak self] in
            guard let self, !showing else { return }
            held = nil
            unlockedBySheet = false
            let surface = code == ProGate.unreadable ? .pro(.unreadable) : licence().map(LockSurface.init)
            show(surface ?? .pro(.key))
        }
    }

    /// The sheet's own action unlocked writing: the intent runs once the sheet has gone.
    /// A purchase that ends after its sheet was swiped away unlocks nothing for a later sheet.
    func unlocked() {
        guard showing else { return }
        unlockedBySheet = true
    }

    /// After a fresh read on Rust's word that the licence changed (Ask to Buy approved, an
    /// entitlement retry, a key added elsewhere): a surface over a licence that now allows writing
    /// closes, and the intent continues as after the sheet's own unlock.
    func licenceChanged() {
        guard showing, !locked() else { return }
        unlockedBySheet = true
        dismiss()
    }

    /// The intent goes, whatever happens to the sheet: the app left the foreground.
    func drop() {
        held = nil
        unlockedBySheet = false
    }

    /// In the sheet's dismissal completion, so a push never runs under a falling sheet. The kept
    /// intent goes through the gate again, never around it.
    func dismissed() {
        showing = false
        let kept = held
        let unlocked = unlockedBySheet
        held = nil
        unlockedBySheet = false
        guard unlocked, let kept, now().timeIntervalSince(kept.at) < ProGate.intentLifetime else { return }
        refresh { [weak self] in self?.require(kept.intent) }
    }

    private func show(_ surface: LockSurface) {
        showing = true
        present(surface)
    }
}
