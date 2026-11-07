import SwiftUI

/// The purchase sheet's contents (docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md,
/// What the iPhone shows): what Devot Pro unlocks and what stays free, one main action (the trial
/// while it is available, otherwise Devot Pro at StoreKit's price), and the account links. It
/// names no other price and links nowhere: StoreKit's own sheets take the payment.
struct PurchaseOffer: Equatable {
    struct Feature: Equatable {
        let text: String
        let note: String?
    }

    struct Action: Equatable {
        /// The product `direct.store.purchase` buys.
        let product: String
        let title: String
        /// StoreKit's price beside the title, when the title does not name it.
        let price: String?
        let prominent: Bool
    }

    let heading: String
    let features: [Feature]
    let actions: [Action]
    let takesKeys: Bool

    init(licence: Licence, products: [StoreProduct]) {
        let price = products.first { $0.product == "pro" }?.displayPrice
        if licence.trial?.state == "available" {
            heading = L10n.phonePurchaseTitle()
        } else if licence.appStore?.code != nil {
            heading = L10n.phonePurchaseUnknown()
        } else {
            heading = licence.trial?.state == "ended" ? L10n.phonePurchaseEnded() : L10n.phonePurchaseTitle()
        }
        features = [
            Feature(text: L10n.phonePurchaseFeatureEdit(), note: L10n.phonePurchaseFeatureFree()),
            Feature(text: L10n.phonePurchaseFeatureSync(), note: nil),
            Feature(text: L10n.phonePurchaseFeatureAi(), note: nil),
        ]
        if licence.trial?.state == "available" {
            actions = [
                Action(
                    product: "trial", title: L10n.phonePurchaseTryFree(days: String(Licence.trialDays)), price: nil,
                    prominent: true),
                Action(
                    product: "pro", title: price.map { L10n.phonePurchaseBuyOnce(price: $0) } ?? L10n.phonePurchaseBuy(),
                    price: nil, prominent: false),
            ]
        } else {
            actions = [Action(product: "pro", title: L10n.phonePurchaseBuy(), price: price, prominent: true)]
        }
        takesKeys = licence.appStore?.takesKeys == true
    }
}

/// What the sheet says under its features while or after an action runs.
enum PurchaseMessage: Equatable {
    case pending
    case nothingRestored
    case failed(String)
    case restoreFailed(String)

    var text: String {
        switch self {
        case .pending: L10n.phonePurchasePending()
        case .nothingRestored: L10n.phonePurchaseNothingRestored()
        case .failed(let code): L10n.phonePurchaseFailed(problem: LicenceText.problem(code))
        case .restoreFailed(let code): L10n.phonePurchaseRestoreFailed(problem: LicenceText.problem(code))
        }
    }

    var isFailure: Bool {
        switch self {
        case .failed, .restoreFailed: true
        case .pending, .nothingRestored: false
        }
    }
}

struct PurchaseSheet: View {
    let store: SettingsStore
    let close: () -> Void
    let enterKey: () -> Void
    @State private var busy: String?
    @State private var message: PurchaseMessage?

    var body: some View {
        let offer = PurchaseOffer(licence: store.licence ?? Licence(gated: true, state: "none"), products: store.products)
        VStack(spacing: SheetMetrics.gap) {
            HStack {
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark")
                        .frame(width: Tokens.Size.phoneTarget, height: Tokens.Size.phoneTarget)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel(L10n.phoneClose())
            }
            SheetLens(symbol: "bird")
            Text(offer.heading).font(.title3.bold()).multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: SheetMetrics.gap / 2) {
                ForEach(offer.features, id: \.text) { feature in
                    Label {
                        VStack(alignment: .leading) {
                            Text(feature.text)
                            if let note = feature.note {
                                Text(note).settingsDetail()
                            }
                        }
                    } icon: {
                        Image(systemName: "checkmark").foregroundStyle(Color(Tokens.Color.accentText))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let message {
                Text(message.text).settingsDetail().multilineTextAlignment(.center)
                    .foregroundStyle(Color(message.isFailure ? Tokens.Color.phoneDestructive : Tokens.Color.phoneTextSecondary))
            }
            ForEach(offer.actions, id: \.product) { action in
                SheetButton(title: action.title, detail: action.price, prominent: action.prominent) {
                    buy(action.product)
                }
                .disabled(busy != nil)
            }
            HStack(spacing: SheetMetrics.gap) {
                Button(L10n.phonePurchaseRestore(), action: restore).disabled(busy != nil)
                if offer.takesKeys {
                    Divider().frame(height: SheetMetrics.gap)
                    Button(L10n.phonePurchaseEnterKey(), action: enterKey)
                }
            }
            .settingsDetail()
            .tint(Color(Tokens.Color.accentText))
        }
        .padding(.horizontal, Tokens.Size.phoneGroupedPadX)
        .padding(.bottom, SheetMetrics.gap)
    }

    private func buy(_ product: String) {
        busy = product
        message = nil
        store.run(.storePurchase, ["product": .string(product)]) { result in
            busy = nil
            switch result {
            case .success(let bought):
                if bought.string == "purchased" {
                    store.readLicence()
                    close()
                } else if bought.string == "pending" {
                    message = .pending
                }
            case .failure(let failure):
                store.log("W_PHONE_PURCHASE_FAILED code=\(failure.code)")
                message = .failed(failure.code)
            }
        }
    }

    private func restore() {
        busy = "restore"
        message = nil
        store.run(.storeRestore) { result in
            busy = nil
            switch result {
            case .success(let snapshot):
                store.adoptLicence(snapshot)
                if store.licence?.allows(Date()) == true { close() } else { message = .nothingRestored }
            case .failure(let failure):
                store.log("W_PHONE_RESTORE_FAILED code=\(failure.code)")
                message = .restoreFailed(failure.code)
            }
        }
    }
}
