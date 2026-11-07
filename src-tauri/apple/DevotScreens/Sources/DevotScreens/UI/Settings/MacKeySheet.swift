import SwiftUI
import UIKit

/// The Devot Pro purchase's Mac licence key, to copy or share to a Mac: this iPhone never adds it.
struct MacKeySheet: View {
    let store: SettingsStore
    let done: () -> Void
    let share: (String) -> Void
    @State private var key: String?
    @State private var failure: String?
    @State private var copied = false

    var body: some View {
        VStack(spacing: SheetMetrics.gap) {
            SheetLens(symbol: "key.horizontal")
            Text(L10n.phoneMacKeyTitle()).font(.system(size: 20, weight: .bold)).accessibilityAddTraits(.isHeader)
            Text(L10n.phoneMacKeyBody()).settingsDetail().multilineTextAlignment(.center)
            if let key {
                Text(key).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                    .multilineTextAlignment(.center)
                SheetButton(title: L10n.phoneMacKeyCopy()) {
                    UIPasteboard.general.string = key
                    copied = true
                }
                SheetButton(title: L10n.phoneMacKeyShare(), prominent: false) { share(key) }
                if copied { Text(L10n.phoneMacKeyCopied()).settingsDetail() }
            } else if let failure {
                Text(L10n.phoneMacKeyFailed(problem: LicenceText.problem(failure))).settingsDetail()
                    .foregroundStyle(Color(Tokens.Color.phoneDestructive)).multilineTextAlignment(.center)
                SheetButton(title: L10n.phoneMacKeyRetry(), action: load)
            } else {
                Text(L10n.phoneMacKeyGetting()).settingsDetail()
            }
            SheetButton(title: L10n.phoneHintDone(), prominent: false, action: done)
        }
        .padding(.horizontal, Tokens.Size.phoneGroupedPadX)
        .padding(.vertical, SheetMetrics.gap)
        .onAppear(perform: load)
    }

    private func load() {
        failure = nil
        store.run(.storeMacKey) { result in
            switch result {
            case .success(let value):
                if let found = value["key"]?.string { key = found } else { failure = "E_APP_STORE_EXCHANGE_FAILED" }
            case .failure(let error):
                store.log("W_PHONE_MAC_KEY_FAILED code=\(error.code)")
                failure = error.code
            }
        }
    }
}
