import XCTest

@testable import DevotScreens

/// The purchase sheet's offer, as `appStoreSurfaces.test.tsx` checks the page's.
@MainActor
final class PurchaseOfferTests: XCTestCase {
    private let price = [StoreProduct(product: "pro", displayPrice: "31,99 \u{20AC}")]

    private func licence(trial: String, code: String? = nil, takesKeys: Bool = false) -> Licence {
        Licence(
            gated: true, state: "none", trial: Licence.Trial(state: trial, endsAt: nil, code: nil),
            appStore: Licence.AppStore(pro: false, code: code, takesKeys: takesKeys))
    }

    func testWhileTheTrialIsAvailableItLeadsAndBuyingOnceNamesStoreKitsPrice() {
        let offer = PurchaseOffer(licence: licence(trial: "available"), products: price)
        XCTAssertEqual(offer.heading, L10n.phonePurchaseTitle())
        XCTAssertEqual(offer.actions.map(\.product), ["trial", "pro"])
        XCTAssertEqual(offer.actions.map(\.prominent), [true, false])
        XCTAssertEqual(offer.actions[0].title, L10n.phonePurchaseTryFree(days: "30"))
        XCTAssertEqual(offer.actions[1].title, L10n.phonePurchaseBuyOnce(price: "31,99 \u{20AC}"))
        XCTAssertEqual(offer.features.count, 3)
    }

    func testOnceTheTrialHasEndedDevotProIsTheOneActionAtItsPrice() {
        let offer = PurchaseOffer(licence: licence(trial: "ended"), products: price)
        XCTAssertEqual(offer.heading, L10n.phonePurchaseEnded())
        XCTAssertEqual(
            offer.actions,
            [PurchaseOffer.Action(product: "pro", title: L10n.phonePurchaseBuy(), price: "31,99 \u{20AC}", prominent: true)])
    }

    func testWithoutStoreKitsPriceNoPriceShowsAndNothingLinksOut() {
        for trial in ["available", "ended"] {
            let offer = PurchaseOffer(licence: licence(trial: trial), products: [])
            XCTAssertTrue(offer.actions.allSatisfy { $0.price == nil })
            let words = [offer.heading] + offer.actions.map(\.title) + offer.features.flatMap { [$0.text, $0.note ?? ""] }
            XCTAssertFalse(words.contains { $0.contains("http") || $0.contains("$") || $0.contains("\u{20AC}") })
        }
    }

    func testAnUnreadEntitlementSaysSoAndKeysShowOnlyWhereTheBuildTakesThem() {
        XCTAssertEqual(
            PurchaseOffer(licence: licence(trial: "ended", code: Licence.unread), products: price).heading,
            L10n.phonePurchaseUnknown())
        XCTAssertFalse(PurchaseOffer(licence: licence(trial: "ended"), products: price).takesKeys)
        XCTAssertTrue(PurchaseOffer(licence: licence(trial: "ended", takesKeys: true), products: price).takesKeys)
    }
}
