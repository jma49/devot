import WebKit
import XCTest

@testable import DevotScreens

@MainActor
final class GlassMigrationTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "devot.tests.glass-migration"

    override func setUp() {
        super.setUp()
        UserDefaults().removePersistentDomain(forName: suite)
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private func started() -> (SettingsScreens, GlassStyleStore, FakeBridge) {
        let glass = GlassStyleStore(defaults: defaults, reduced: { false })
        let screens = SettingsScreens(host: WebViewHost(webView: WKWebView()), glass: glass)
        let bridge = FakeBridge()
        screens.bridge = bridge
        screens.start()
        return (screens, glass, bridge)
    }

    func testAFailedReadLeavesThePagesValueAndTriesAgainNextLaunch() {
        let (first, glass, bridge) = started()
        bridge.answer("glass.get", .failed("E_SCREENS_PAGE_RELOADED"))
        XCTAssertFalse(bridge.ops.contains("glass.set"))
        XCTAssertTrue(glass.needsMigration)
        XCTAssertTrue(bridge.lines.contains("W_PHONE_GLASS_MIGRATE_FAILED code=E_SCREENS_PAGE_RELOADED"))
        withExtendedLifetime(first) {}

        let (next, again, nextBridge) = started()
        nextBridge.answer("glass.get", .ok(.object(["transparency": .number(-50)])))
        XCTAssertEqual(again.transparency, -50)
        XCTAssertFalse(again.needsMigration)
        XCTAssertEqual(nextBridge.sent.first { $0.op == "glass.set" }?.args["transparency"], .number(-50))
        withExtendedLifetime(next) {}
    }

    func testAMigratedValueIsSentWithoutAskingThePage() {
        defaults.set(25, forKey: GlassStyleStore.key)
        let (screens, _, bridge) = started()
        XCTAssertFalse(bridge.ops.contains("glass.get"))
        XCTAssertEqual(bridge.sent.first { $0.op == "glass.set" }?.args["transparency"], .number(25))
        withExtendedLifetime(screens) {}
    }
}
