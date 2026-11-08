import UIKit
import XCTest

@testable import DevotScreens

@MainActor
final class GlassStyleStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "devot.tests.glass"

    override func setUp() {
        super.setUp()
        UserDefaults().removePersistentDomain(forName: suite)
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func testABelowZeroValueFirmsEveryRegisteredScrollEdgeAndZeroRestoresTheSystems() {
        let store = GlassStyleStore(defaults: defaults, reduced: { false })
        let views = [UIScrollView(), UIScrollView()]
        views.forEach(store.register)
        store.apply(-50)
        for view in views {
            XCTAssertEqual(view.topEdgeEffect.style, .hard)
            XCTAssertEqual(view.bottomEdgeEffect.style, .hard)
        }
        store.apply(0)
        for view in views {
            XCTAssertEqual(view.topEdgeEffect.style, .automatic)
            XCTAssertEqual(view.bottomEdgeEffect.style, .automatic)
        }
        let later = UIScrollView()
        store.apply(-5)
        store.register(later)
        XCTAssertEqual(later.topEdgeEffect.style, .hard)
    }

    func testDraggingAppliesAtOnceAndOnlyReleaseWrites() {
        let store = GlassStyleStore(defaults: defaults, reduced: { false })
        var told: [Int] = []
        store.onChange = { told.append($0) }
        store.apply(-35)
        XCTAssertEqual(store.transparency, -35)
        XCTAssertEqual(store.style, .regular(tint: 0.35))
        XCTAssertNil(defaults.object(forKey: GlassStyleStore.key))
        store.commit()
        XCTAssertEqual(defaults.integer(forKey: GlassStyleStore.key), -35)
        XCTAssertEqual(told, [-35])
        XCTAssertEqual(GlassStyleStore(defaults: defaults, reduced: { false }).transparency, -35)
    }

    func testTakesThePagesValueOnceWhenNothingIsStored() {
        let store = GlassStyleStore(defaults: defaults, reduced: { false })
        XCTAssertTrue(store.needsMigration)
        store.migrate(40)
        XCTAssertEqual(store.transparency, 40)
        XCTAssertEqual(defaults.integer(forKey: GlassStyleStore.key), 40)
        XCTAssertFalse(store.needsMigration)
        store.migrate(-80)
        XCTAssertEqual(store.transparency, 40)
    }

    func testWithNothingOnThePageItStoresTheDesignSoItNeverAsksAgain() {
        let store = GlassStyleStore(defaults: defaults, reduced: { false })
        store.migrate(nil)
        XCTAssertEqual(store.transparency, 0)
        XCTAssertFalse(store.needsMigration)
    }

    func testReduceTransparencyMakesDevotsGlassSolidAndLocksTheSlider() {
        var reduced = true
        let store = GlassStyleStore(defaults: defaults, reduced: { reduced })
        store.apply(60)
        XCTAssertTrue(store.reduced)
        XCTAssertEqual(store.style, .solid)
        reduced = false
        store.accessibilityChanged()
        XCTAssertEqual(store.style, .clear(tint: 0.1))
    }
}
