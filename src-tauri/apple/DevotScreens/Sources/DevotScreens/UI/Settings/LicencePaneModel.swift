import Foundation
import Observation

/// The License pane's key field and its one licence action at a time: Add or Replace, Remove and
/// Retry each write the licence, so none starts while another runs.
@Observable
@MainActor
final class LicencePaneModel {
    enum Action: Equatable {
        case idle
        case running(DirectOp)
        case done(String)
        case failed(String)
    }

    let store: SettingsStore
    var key = ""
    private(set) var action = Action.idle

    init(store: SettingsStore) {
        self.store = store
    }

    var busy: Bool {
        if case .running = action { return true }
        return false
    }

    var announcement: String? {
        if case .done(let text) = action { return text }
        return nil
    }

    var problem: String? {
        if case .failed(let text) = action { return text }
        return nil
    }

    func add() {
        guard !busy, !key.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        act(.licenceSet, ["key": .string(key)], done: L10n.licenceSettingsAdded()) { [weak self] in
            self?.key = ""
        } failed: {
            L10n.licenceSettingsAddFailed(problem: LicenceText.problem($0))
        }
    }

    func remove() {
        guard !busy else { return }
        act(.licenceRemove, done: L10n.licenceSettingsRemoved()) {} failed: {
            LicenceText.failure(L10n.licenceSettingsRemoveFailed(), $0)
        }
    }

    func retry() {
        guard !busy else { return }
        act(.licenceRefresh, done: L10n.licenceSettingsDevicesRefreshed()) {} failed: {
            L10n.licenceSettingsDevicesRefreshFailed(problem: LicenceText.problem($0))
        }
    }

    private func act(
        _ op: DirectOp, _ args: [String: JSONValue] = [:], done: String, then: @escaping () -> Void,
        failed: @escaping (String) -> String
    ) {
        action = .running(op)
        store.run(op, args) { [weak self] result in
            guard let self, action == .running(op) else { return }
            switch result {
            case .success(let snapshot):
                store.adoptLicence(snapshot)
                action = .done(done)
                then()
            case .failure(let failure):
                store.log("W_LICENCE_SETTINGS_FAILED op=\(op.rawValue) code=\(failure.code)")
                action = .failed(failed(failure.code))
            }
        }
    }
}
