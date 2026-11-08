import Foundation
import Observation
import UIKit
import UniformTypeIdentifiers

/// The Sync pane's own state and actions over the Rust-direct sync operations (`SyncSection.tsx`,
/// `SyncDevices.tsx`, `SyncICloud.tsx`). The store holds the snapshot; this holds what the owner
/// is doing in the pane. A pairing on show ends when the pane leaves the stack, not on a tab switch.
@Observable
@MainActor
final class SyncPaneModel {
    enum Confirm: Equatable {
        case icloud(ICloudAttention.Action)
        case moveToICloud
        case leaveVault
        case removeDevice(SyncDevice)
        case linkRelay(String)
    }

    enum Progress: Equatable {
        case waiting, taken
    }

    static let pollSeconds = 2.0
    static let icloudPollSeconds = 10.0
    /// The Mac's `SECRET_CLIPBOARD_SECS`: a copied key leaves the pasteboard after it.
    static let clipboardSeconds = 90.0
    private static let transient: Set<String> = ["E_SYNC_OFFLINE", "E_SYNC_RELAY_FAILED"]

    let store: SettingsStore
    var problem: String?
    var announcement: String?
    var recoveryKey: String?
    var path: SyncLayout.Path?
    var relayChosen: Bool?
    var url: String?
    var secret = ""
    var code = ""
    var recovery = ""
    var leaveKey = ""
    var askingLeaveKey = false
    var confirm: Confirm?
    private(set) var busy = false
    private(set) var usage = SyncLayout.Usage.reading
    private(set) var stored = SyncLayout.Stored.reading
    private(set) var devices: [SyncDevice]?
    private(set) var devicesProblem: String?
    private(set) var removing: Set<String> = []
    private(set) var pairing: ShownPairing?
    private(set) var progress = Progress.waiting
    private(set) var unreachable = false
    private(set) var pairingEnded: String?
    @ObservationIgnored private var poll: Task<Void, Never>?
    @ObservationIgnored private var checks = 0
    @ObservationIgnored private var gone = false
    @ObservationIgnored private var savingDraft: String?
    @ObservationIgnored var copy: @MainActor (String) -> Void = SyncPaneModel.copySecret

    init(store: SettingsStore) {
        self.store = store
    }

    var snapshot: SyncSnapshot { store.sync ?? .off }

    var lockedSentence: String? {
        guard let licence = store.licence, !licence.allows(store.now) else { return nil }
        return LicenceText.syncLocked(licence, store.now)
    }

    var locked: Bool { lockedSentence != nil }

    var layout: [SyncLayout.Section] {
        SyncLayout.sections(
            SyncLayout.Input(
                snapshot: snapshot, icloud: store.icloud, locked: lockedSentence, now: store.now,
                recoveryKey: recoveryKey, path: path, relayChosen: relayChosen, usage: usage, stored: stored,
                devices: devices, devicesProblem: devicesProblem, pairingEnded: pairingEnded,
                askingLeaveKey: askingLeaveKey))
    }

    // MARK: reads

    func appeared() {
        store.readSync()
        changed(from: nil)
    }

    /// What the pane reads again after the snapshot changes, as the page's effects do.
    func changed(from old: SyncSnapshot?) {
        let now = snapshot
        if now.inVault, old?.inVault != true {
            readRecoveryKey()
            readDevices()
        }
        let usageInputs = { (s: SyncSnapshot) in
            [s.relayUrl, "\(s.enabled)", s.status.state, s.status.code ?? "", "\(s.status.lastSync ?? -1)", "\(s.enrolled)"]
        }
        if now.enrolled, old.map(usageInputs) != usageInputs(now) { readUsage() }
        if now.onICloud, old?.status.lastSync != now.status.lastSync || old?.onICloud != true { readStored() }
    }

    private func readRecoveryKey() {
        store.run(.syncRecoveryKey) { [weak self] result in
            guard let self, case .success(let value) = result, let key = value.string,
                key.range(of: #"^[0-9A-Z]{5}(-[0-9A-Z]{1,5})+$"#, options: .regularExpression) != nil
            else { return }
            recoveryKey = key
        }
    }

    func readUsage() {
        store.run(.syncUsage) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value):
                usage = StorageView(value).map(SyncLayout.Usage.ready) ?? .failed(code: "E_SYNC_PROTOCOL")
            case .failure(let failure):
                store.log("W_SYNC_USAGE_FAILED code=\(failure.code)")
                usage = .failed(code: failure.code)
            }
        }
    }

    private func readStored() {
        store.run(.syncIcloudStorage) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value):
                if let bytes = SyncSnapshot.count(value) {
                    stored = .ready(bytes)
                } else {
                    stored = .failed(code: logged("E_SYNC_ICLOUD_STORAGE_INVALID", op: .syncIcloudStorage))
                }
            case .failure(let failure): stored = .failed(code: logged(failure.code, op: .syncIcloudStorage))
            }
        }
    }

    func readDevices() {
        store.run(.syncDevices) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value):
                devicesProblem = nil
                devices = SyncDevice.list(value)
            case .failure(let failure):
                devicesProblem = SyncText.failure("syncSettings.devicesFailed", logged(failure.code, op: .syncDevices))
            }
        }
    }

    // MARK: changes

    private func logged(_ code: String, op: DirectOp) -> String {
        store.log("W_SYNC_SETTINGS_FAILED op=\(op.rawValue) code=\(code)")
        return code
    }

    private func failed(_ message: String, _ code: String, op: DirectOp) {
        announcement = nil
        problem = SyncText.failure(message, logged(code, op: op))
    }

    private func announce(_ key: String) {
        problem = nil
        announcement = catalog(key)
    }

    /// Runs a change that answers a snapshot, then `then`; a failure says `message` and why.
    private func change(
        _ op: DirectOp, _ args: [String: JSONValue] = [:], failing message: String,
        then: @escaping (JSONValue) -> Void = { _ in }
    ) {
        busy = true
        store.run(op, args) { [weak self] result in
            guard let self else { return }
            busy = false
            switch result {
            case .success(let value):
                problem = nil
                then(value)
            case .failure(let failure): failed(message, failure.code, op: op)
            }
        }
    }

    func setEnabled(_ on: Bool) {
        change(.syncSet, ["patch": .object(["enabled": .bool(on)])], failing: "syncSettings.changeFailed") {
            [weak self] in self?.store.adoptSync($0)
        }
    }

    func saveUrl() {
        savingUrl {}
    }

    /// Saves a relay the owner typed but did not submit, then goes on: the page saves it on blur.
    private func savingUrl(then next: @escaping () -> Void) {
        guard let draft = url, draft.trimmingCharacters(in: .whitespaces) != snapshot.relayUrl else {
            url = nil
            return next()
        }
        // Done also ends the field's focus, and each saves.
        if busy, draft == savingDraft { return }
        savingDraft = draft
        change(.syncSet, ["patch": .object(["relayUrl": .string(draft)])], failing: "syncSettings.urlFailed") {
            [weak self] in
            self?.store.adoptSync($0)
            self?.url = nil
            next()
        }
    }

    func choose(_ next: SyncLayout.Path) {
        path = next
    }

    func backOut() {
        secret = ""
        path = nil
        saveUrl()
    }

    func create() {
        guard !secret.trimmingCharacters(in: .whitespaces).isEmpty, !busy, !locked else { return }
        savingUrl { [weak self] in self?.createVault() }
    }

    private func createVault() {
        change(.syncVaultCreate, ["relaySecret": .string(secret)], failing: "syncSettings.vaultFailed") {
            [weak self] value in
            guard let self else { return }
            if let snapshot = value["snapshot"] { store.adoptSync(snapshot) }
            secret = ""
            path = nil
            if let key = value["recoveryKey"]?.string { recoveryKey = key }
            announce("syncSettings.vaultReady")
        }
    }

    func copyRecoveryKey() {
        guard let recoveryKey else { return }
        copy(recoveryKey)
        announce("syncSettings.recoveryCopied")
    }

    /// Kept on this device only, and gone from the pasteboard after a while.
    private static func copySecret(_ text: String) {
        UIPasteboard.general.setItems(
            [[UTType.utf8PlainText.identifier: text]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(clipboardSeconds)])
    }

    func recoverySaved() {
        change(.syncRecoverySaved, failing: "syncSettings.recoverySaveFailed") { [weak self] _ in
            self?.recoveryKey = nil
        }
    }

    func join(recovery byKey: Bool, icloud: Bool) {
        let text = byKey ? recovery : code
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty, !busy, !locked else { return }
        if icloud { return joinOn(recovery: byKey, icloud: true, text) }
        savingUrl { [weak self] in self?.joinOn(recovery: byKey, icloud: false, text) }
    }

    private func joinOn(recovery byKey: Bool, icloud: Bool, _ text: String) {
        if icloud {
            if byKey {
                send(.syncIcloudUse, ["recoveryKey": .string(text)])
            } else {
                send(.syncJoinCode, ["code": .string(text), "via": .string("icloud")])
            }
            return
        }
        if byKey { return send(.syncJoinRecovery, ["recoveryKey": .string(text)]) }
        if snapshot.relayUrl.isEmpty, let named = SyncLinks.relay(text) {
            guard SyncLinks.allowed(named) else {
                return failed("syncSettings.joinFailed", "E_SYNC_RELAY_URL_INVALID", op: .syncJoinCode)
            }
            confirm = .linkRelay(named)
            return
        }
        send(.syncJoinCode, ["code": .string(text)])
    }

    func joinOnRelay(_ relay: String) {
        change(.syncSet, ["patch": .object(["relayUrl": .string(relay)])], failing: "syncSettings.joinFailed") {
            [weak self] value in
            guard let self else { return }
            store.adoptSync(value)
            send(.syncJoinCode, ["code": .string(code)])
        }
    }

    private func send(_ op: DirectOp, _ args: [String: JSONValue]) {
        change(op, args, failing: "syncSettings.joinFailed") { [weak self] value in
            guard let self else { return }
            store.adoptSync(value)
            code = ""
            recovery = ""
            announce("syncSettings.joined")
        }
    }

    private static let icloudRuns: [ICloudAttention.Action: (DirectOp, [String: JSONValue])] = [
        .moveHere: (.syncIcloudUploadAgain, [:]),
        .uploadAgain: (.syncIcloudUploadAgain, [:]),
        .turnOff: (.syncSet, ["patch": .object(["enabled": .bool(false)])]),
        .follow: (.syncIcloudUse, [:]),
        .finish: (.syncIcloudUse, [:]),
        .join: (.syncIcloudJoin, ["accept": .bool(true)]),
        .decline: (.syncIcloudJoin, ["accept": .bool(false)]),
    ]

    static let confirmed: Set<ICloudAttention.Action> = [.moveHere, .uploadAgain]

    /// Asks first for a confirmed action; the alert's button then calls `perform`.
    func act(_ action: ICloudAttention.Action) {
        if Self.confirmed.contains(action) {
            confirm = .icloud(action)
        } else {
            perform(action)
        }
    }

    func perform(_ action: ICloudAttention.Action) {
        confirm = nil
        guard let (op, args) = Self.icloudRuns[action] else { return }
        change(op, args, failing: "syncSettings.icloudChangeFailed") { [weak self] in self?.store.adoptSync($0) }
    }

    /// The transport question's Use iCloud, or Join after the owner declined once.
    func startICloud(declined: Bool) {
        guard !locked else { return }
        let (op, args): (DirectOp, [String: JSONValue]) =
            declined ? (.syncIcloudJoin, ["accept": .bool(true)]) : (.syncIcloudUse, [:])
        change(op, args, failing: "syncSettings.icloudChangeFailed") { [weak self] in self?.store.adoptSync($0) }
    }

    func moveToICloud() {
        confirm = nil
        change(.syncIcloudUse, failing: "syncSettings.icloudChangeFailed") { [weak self] in self?.store.adoptSync($0) }
    }

    func leaveVault() {
        confirm = nil
        change(.syncVaultLeave, failing: "syncSettings.leaveFailed") { [weak self] value in
            self?.store.adoptSync(value)
            self?.announce("syncSettings.left")
        }
    }

    func leaveICloud() {
        guard !leaveKey.trimmingCharacters(in: .whitespaces).isEmpty, !busy else { return }
        change(.syncIcloudLeave, ["recoveryKey": .string(leaveKey)], failing: "syncSettings.icloudLeaveFailed") {
            [weak self] value in
            guard let self else { return }
            store.adoptSync(value)
            leaveKey = ""
            askingLeaveKey = false
            announce("syncSettings.icloudLeft")
        }
    }

    func cancelLeaveICloud() {
        leaveKey = ""
        askingLeaveKey = false
    }

    func remove(_ device: SyncDevice) {
        confirm = nil
        guard !removing.contains(device.id) else { return }
        removing.insert(device.id)
        store.run(.syncDeviceRemove, ["device": .string(device.id)]) { [weak self] result in
            guard let self else { return }
            removing.remove(device.id)
            switch result {
            case .success(let value):
                devices = SyncDevice.list(value)
                devicesProblem = nil
                announce("syncSettings.deviceRemoved")
            case .failure(let failure): failed("syncSettings.removeFailed", failure.code, op: .syncDeviceRemove)
            }
        }
    }

    // MARK: pairing

    func showPairing() {
        guard !busy, !locked, pairing == nil else { return }
        pairingEnded = nil
        busy = true
        store.run(.syncPairingOpen) { [weak self] result in
            guard let self else { return }
            busy = false
            switch result {
            case .success(let value):
                if gone { return store.run(.syncPairingCancel) { _ in } }
                guard let shown = ShownPairing(value) else {
                    return failed("syncSettings.pairFailed", "E_SYNC_PAIRING_INVALID", op: .syncPairingOpen)
                }
                problem = nil
                progress = .waiting
                unreachable = false
                pairing = shown
                schedule()
            case .failure(let failure): failed("syncSettings.pairFailed", failure.code, op: .syncPairingOpen)
            }
        }
    }

    private func schedule() {
        poll?.cancel()
        let seconds = snapshot.onICloud ? Self.icloudPollSeconds : Self.pollSeconds
        poll = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.checkPairing()
        }
    }

    /// Checks at once: on `sync.pairing`, and when each wait ends.
    func checkPairing() {
        guard pairing != nil else { return }
        poll?.cancel()
        checks += 1
        let check = checks
        store.run(.syncPairingCheck) { [weak self] result in
            guard let self, check == checks, pairing != nil else { return }
            switch result {
            case .success(let value):
                unreachable = false
                switch value["state"]?.string {
                case "paired" where value["device"]?.string != nil:
                    end()
                    announce("syncSettings.pairDone")
                    readDevices()
                case "expired": end("syncSettings.pairExpired")
                case "unconfirmed":
                    end("syncSettings.pairUnconfirmed")
                    readDevices()
                case "taken":
                    progress = .taken
                    schedule()
                case "waiting":
                    progress = .waiting
                    schedule()
                default: lost("E_SYNC_PAIRING_INVALID")
                }
            case .failure(let failure):
                if Self.transient.contains(failure.code) {
                    unreachable = true
                    schedule()
                } else {
                    lost(failure.code)
                }
            }
        }
    }

    private func lost(_ code: String) {
        end()
        store.run(.syncPairingCancel) { _ in }
        failed("syncSettings.pairCheckFailed", code, op: .syncPairingCheck)
        readDevices()
    }

    private func end(_ message: String? = nil) {
        poll?.cancel()
        poll = nil
        pairing = nil
        unreachable = false
        pairingEnded = message
        if let message { announce(message) }
    }

    func cancelPairing() {
        guard pairing != nil else { return }
        end()
        store.run(.syncPairingCancel) { _ in }
    }

    var progressText: String {
        catalog(unreachable ? "syncSettings.pairRetrying" : progress == .taken ? "syncSettings.pairTaken" : "syncSettings.pairWaiting")
    }

    /// The pane left the stack: a pairing on show, or still opening, ends with it, and a typed relay is kept.
    func left() {
        gone = true
        cancelPairing()
        saveUrl()
    }
}
