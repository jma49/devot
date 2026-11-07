import SwiftUI

/// The short Pro sheet's words for each lock that is not a purchase (`SHEETS` in
/// `PhoneProSheet.tsx`). It names no price and links nowhere.
struct ProSheetContent: Equatable {
    let title: String
    let body: String
    let action: String
    /// Restore Purchases under the action, while App Store purchases could not be checked.
    let restores: Bool

    init(_ kind: ProSheetKind) {
        switch kind {
        case .checking:
            title = L10n.phonePurchaseUnknown()
            body = L10n.phoneProBodyChecking()
            action = L10n.phoneProTryAgain()
        case .key:
            title = L10n.phonePurchaseEnded()
            body = L10n.phoneProBodyKey()
            action = L10n.phonePurchaseEnterKey()
        case .attention:
            title = L10n.phoneProTitleAttention()
            body = L10n.phoneProBodyAttention()
            action = L10n.phoneProOpenLicence()
        case .seat:
            title = L10n.phoneProTitleAttention()
            body = L10n.phoneProBodySeat()
            action = L10n.phoneProOpenLicence()
        case .unreadable:
            title = L10n.phoneProTitleUnreadable()
            body = L10n.phoneProBodyUnreadable()
            action = L10n.phoneProTryAgain()
        }
        restores = kind == .checking
    }

    var strings: [String] {
        [title, body, action, L10n.phoneProNotNow()] + (restores ? [L10n.phonePurchaseRestore()] : [])
    }
}

/// What the Pro sheet's actions do; the screens answer them.
struct ProSheetActions {
    /// Enter License Key (focusing the key) or Open License Settings: the sheet goes, the intent too.
    let openLicence: (_ focusKey: Bool) -> Void
    /// The licence unlocked: the gate runs the intent once the sheet has gone.
    let unlocked: () -> Void
    let close: () -> Void
}

/// A short sheet in the purchase sheet's family: the lens with the dove, a title, one line, one
/// filled action and Not Now. The grabber and a swipe down close it too; it has no close circle.
struct ProSheet: View {
    let kind: ProSheetKind
    let store: SettingsStore
    let actions: ProSheetActions
    @State private var busy = false
    @State private var message: String?
    @AccessibilityFocusState private var titleFocused: Bool

    var body: some View {
        let content = ProSheetContent(kind)
        VStack(spacing: SheetMetrics.gap) {
            SheetLens(symbol: "bird")
            Text(content.title).sheetTitle().multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
                .accessibilityFocused($titleFocused)
            Text(content.body).sheetMessage().multilineTextAlignment(.center)
            if let message {
                Text(message).settingsDetail().multilineTextAlignment(.center)
            }
            SheetButton(title: content.action, detail: nil, prominent: true, action: act)
                .disabled(busy)
            if content.restores {
                Button(action: restore) { secondary(L10n.phonePurchaseRestore()) }.disabled(busy)
            }
            Button(action: actions.close) { secondary(L10n.phoneProNotNow()) }
        }
        .padding(.horizontal, Tokens.Size.phoneGroupedPadX)
        .padding(.top, SheetMetrics.gap)
        .padding(.bottom, SheetMetrics.gap)
        .accessibilityElement(children: .contain)
        .onAppear { titleFocused = true }
    }

    private func secondary(_ title: String) -> some View {
        Text(title)
            .frame(maxWidth: .infinity, minHeight: Tokens.Size.phoneTarget)
            .contentShape(Rectangle())
            .foregroundStyle(Color(Tokens.Color.accentText))
    }

    private func act() {
        if kind.opensLicence { return actions.openLicence(kind == .key) }
        busy = true
        message = L10n.phoneProChecking()
        store.run(.licenceGet) { result in
            busy = false
            switch result {
            case .success(let snapshot):
                store.adoptLicence(snapshot)
                if store.licence?.allows(Date()) == true {
                    actions.unlocked()
                    actions.close()
                } else {
                    message = L10n.phoneProStillLocked()
                }
            case .failure(let failure):
                store.log("W_LICENCE_READ_FAILED code=\(failure.code)")
                message = L10n.phoneProCheckFailed()
            }
        }
    }

    private func restore() {
        busy = true
        message = nil
        store.run(.storeRestore) { result in
            busy = false
            switch result {
            case .success(let snapshot):
                store.adoptLicence(snapshot)
                if store.licence?.allows(Date()) == true {
                    actions.unlocked()
                    actions.close()
                } else {
                    message = PurchaseMessage.nothingRestored.text
                }
            case .failure(let failure):
                store.log("W_PHONE_RESTORE_FAILED code=\(failure.code)")
                message = PurchaseMessage.restoreFailed(failure.code).text
            }
        }
    }
}
