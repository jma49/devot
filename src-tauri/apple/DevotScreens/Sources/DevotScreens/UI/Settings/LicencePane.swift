import SwiftUI
import UIKit

/// License (`LicenceSection.tsx`): the state and, while locked, Buy; the trial, the seats, who it is
/// for and its ID; the key field where this build takes keys, and Remove behind a confirm. The key
/// goes to Rust, which checks it, and never comes back.
struct LicencePane: View {
    let store: SettingsStore
    let entry: LicenceEntry
    let buy: () -> Void
    @State private var key = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var announcement: String?
    @State private var confirming = false
    @FocusState private var keyFocused: Bool

    var body: some View {
        Form {
            if let problem { ProblemRow(text: problem) }
            if let licence = store.licence {
                rows(licence)
            }
        }
        .settingsPage(store)
        .alert(L10n.licenceSettingsRemoveConfirm(), isPresented: $confirming) {
            Button(L10n.licenceSettingsRemove(), role: .destructive, action: remove)
            Button(L10n.dialogCancel(), role: .cancel) {}
        } message: {
            Text(L10n.licenceSettingsRemoveDetail())
        }
        .onAppear {
            if case .prefill(let value) = entry { key = value }
        }
        .task {
            // The key field takes focus once the push has landed, so the keyboard rises over the page.
            guard entry == .focusKey else { return }
            try? await Task.sleep(for: .milliseconds(350))
            keyFocused = true
        }
    }

    @ViewBuilder
    private func rows(_ licence: Licence) -> some View {
        Section {
            if licence.gated == false, licence.held {
                Text(L10n.licenceSettingsUngated()).settingsDetail().listRowBackground(Color(Tokens.Color.phoneCard))
            }
            RowText(title: L10n.licenceSettingsStatus(), detail: LicenceText.state(licence)).settingsRow(described: true)
            if !licence.unlocked {
                ActionRow(title: licence.soldOnAppStore ? L10n.licenceSettingsBuyPro() : L10n.licenceSettingsBuy(), action: buy)
            }
            if let trial = LicenceText.trial(licence, store.now) {
                RowText(title: L10n.licenceSettingsTrial(), detail: trial).settingsRow(described: true)
            }
            if let seat = licence.activation {
                RowText(title: L10n.licenceSettingsDevices(), detail: LicenceText.seat(licence)).settingsRow(described: true)
                if seat.state != "active" || ["E_LICENCE_DEVICE_LIMIT", "E_LICENCE_ACTIVATION_REQUIRED"].contains(licence.code ?? "") {
                    ActionRow(title: L10n.licenceSettingsDevicesRetry(), busy: busy, action: retry)
                }
                ActionRow(title: L10n.licenceSettingsDevicesManage()) {
                    UIApplication.shared.open(Licence.devicesURL)
                }
            }
            if let licensee = licence.licensee {
                RowText(title: L10n.licenceSettingsLicensee(), detail: LicenceText.licensee(licensee)).settingsRow(described: true)
            }
            if let id = licence.id {
                RowText(title: L10n.licenceSettingsId(), detail: id).settingsRow(described: true)
                    .textSelection(.enabled)
            }
        } footer: {
            Footer(L10n.licenceSettingsDetail())
        }
        if licence.takesKeys {
            Section {
                VStack(alignment: .leading, spacing: Tokens.Space.space4) {
                    RowText(
                        title: L10n.licenceSettingsKey(),
                        detail: licence.held ? L10n.licenceSettingsReplaceHint() : L10n.licenceSettingsKeyHint())
                    TextField(L10n.licenceSettingsKey(), text: $key)
                        .focused($keyFocused)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .submitLabel(.done)
                        .onSubmit(add)
                        .accessibilityIdentifier("licence-key")
                    if let announcement { Text(announcement).settingsDetail() }
                }
                .settingsRow(described: true)
                ActionRow(
                    title: licence.held ? L10n.licenceSettingsReplace() : L10n.licenceSettingsAdd(), busy: busy, action: add
                )
                .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if licence.held {
                Section {
                    ActionRow(title: L10n.licenceSettingsRemoveAsk(), destructive: true) { confirming = true }
                }
            }
        }
    }

    private func add() {
        guard !key.trimmingCharacters(in: .whitespaces).isEmpty, !busy else { return }
        act(.licenceSet, ["key": .string(key)], done: L10n.licenceSettingsAdded()) {
            key = ""
        } failed: {
            L10n.licenceSettingsAddFailed(problem: LicenceText.problem($0))
        }
    }

    private func remove() {
        act(.licenceRemove, done: L10n.licenceSettingsRemoved()) {} failed: {
            LicenceText.failure(L10n.licenceSettingsRemoveFailed(), $0)
        }
    }

    private func retry() {
        guard !busy else { return }
        act(.licenceRefresh, done: L10n.licenceSettingsDevicesRefreshed()) {} failed: {
            L10n.licenceSettingsDevicesRefreshFailed(problem: LicenceText.problem($0))
        }
    }

    private func act(
        _ op: DirectOp, _ args: [String: JSONValue] = [:], done: String, then: @escaping () -> Void,
        failed: @escaping (String) -> String
    ) {
        busy = true
        store.run(op, args) { result in
            busy = false
            switch result {
            case .success(let snapshot):
                store.adoptLicence(snapshot)
                problem = nil
                announcement = done
                then()
            case .failure(let failure):
                store.log("W_LICENCE_SETTINGS_FAILED op=\(op.rawValue) code=\(failure.code)")
                announcement = nil
                problem = failed(failure.code)
            }
        }
    }
}
