import UIKit
import XCTest

@testable import DevotScreens

@MainActor
final class SettingsStoreTests: XCTestCase {
    private func store() -> (SettingsStore, FakeBridge) {
        let bridge = FakeBridge()
        let store = SettingsStore()
        store.bridge = bridge
        return (store, bridge)
    }

    private func editor(_ revision: Double, _ settings: [String: JSONValue]) -> Outcome {
        .ok(.object(["revision": .number(revision), "settings": .object(settings)]))
    }

    func testReadsEverySnapshotFromRustAndTheNotebooksFromThePage() {
        let (store, bridge) = store()
        store.load()
        XCTAssertEqual(
            bridge.ops,
            [
                "direct.editorSettings.get", "direct.crashReports.get", "direct.licence.get", "direct.ai.get",
                "direct.sync.get", "settings.notebooks",
            ])
        bridge.answer("settings.notebooks", .ok(.object(["notebooks": .array([
            .object(["id": .string("a"), "name": .string("Work"), "depth": .number(0)]),
            .object(["id": .string("b"), "name": .string("Plans"), "depth": .number(1)]),
        ])])))
        XCTAssertEqual(store.notebooks, [
            NotebookChoice(id: "a", name: "Work", depth: 0), NotebookChoice(id: "b", name: "Plans", depth: 1),
        ])
        bridge.answer("direct.crashReports.get", .ok(.object(["available": .bool(true), "on": .bool(false)])))
        XCTAssertEqual(store.crashReports, CrashReports(available: true, on: false))
    }

    func testAChangeShowsAtOnceAndRustsSnapshotThenHolds() {
        let (store, bridge) = store()
        store.load()
        bridge.answer("direct.editorSettings.get", editor(1, ["lineNumbers": .bool(false)]))
        store.setEditor("lineNumbers", .bool(true))
        XCTAssertTrue(store.flag("lineNumbers"))
        XCTAssertEqual(bridge.sent.last?.args, ["patch": .object(["lineNumbers": .bool(true)])])
        bridge.answer("direct.editorSettings.set", editor(2, ["lineNumbers": .bool(true), "toolbar": .bool(true)]))
        XCTAssertTrue(store.flag("toolbar"))
        XCTAssertNil(store.failure)
        XCTAssertEqual(bridge.lines, [])
    }

    func testARefusedChangePutsTheOldValueBackSaysSoOnceAndLogsOnlyCodes() {
        let (store, bridge) = store()
        store.load()
        bridge.answer("direct.editorSettings.get", editor(1, ["lineNumbers": .bool(false)]))
        store.setEditor("lineNumbers", .bool(true))
        bridge.answer("direct.editorSettings.set", .failed("E_SETTINGS_WRITE"))
        XCTAssertFalse(store.flag("lineNumbers"))
        XCTAssertEqual(store.failure, L10n.appearanceSettingsFailed())
        XCTAssertEqual(bridge.lines, ["W_PHONE_SETTINGS_SAVE_FAILED key=lineNumbers code=E_SETTINGS_WRITE"])
    }

    func testAnOlderSnapshotNeverReplacesANewerOne() {
        let (store, bridge) = store()
        store.load()
        store.setEditor("tabWidth", .number(8))
        bridge.answer("direct.editorSettings.set", editor(5, ["tabWidth": .number(8)]))
        bridge.answer("direct.editorSettings.get", editor(4, ["tabWidth": .number(4)]))
        XCTAssertEqual(store.editor["tabWidth"], .number(8))
    }

    func testARefusedCrashReportsChangeAndAFailedReadAreLogged() {
        let (store, bridge) = store()
        store.load()
        bridge.answer("direct.crashReports.get", .ok(.object(["available": .bool(true), "on": .bool(true)])))
        store.setCrashReports(false)
        XCTAssertEqual(store.crashReports?.on, false)
        bridge.answer("direct.crashReports.set", .failed("E_CRASH_REPORTS_WRITE"))
        XCTAssertEqual(store.crashReports?.on, true)
        bridge.answer("direct.sync.get", .failed("E_SYNC_STATE"))
        XCTAssertEqual(
            bridge.lines,
            [
                "W_PHONE_SETTINGS_SAVE_FAILED key=crashReports code=E_CRASH_REPORTS_WRITE",
                "W_PHONE_SETTINGS_READ_FAILED op=direct.sync.get code=E_SYNC_STATE",
            ])
    }

    func testAnAppStoreLicenceAsksStoreKitForItsPrice() {
        let (store, bridge) = store()
        store.load()
        bridge.answer(
            "direct.licence.get",
            .ok(.object(["gated": .bool(true), "state": .string("none"), "appStore": .object(["pro": .bool(false)])])))
        XCTAssertEqual(store.licence?.soldOnAppStore, true)
        XCTAssertEqual(bridge.ops.last, "direct.store.products")
        bridge.answer(
            "direct.store.products",
            .ok(.array([.object(["product": .string("pro"), "displayPrice": .string("31,99 \u{20AC}")])])))
        XCTAssertEqual(store.products, [StoreProduct(product: "pro", displayPrice: "31,99 \u{20AC}")])
    }

    func testComingBackToTheForegroundReadsTheClockAndTheLicenceAgain() {
        let center = NotificationCenter()
        let bridge = FakeBridge()
        let store = SettingsStore(center: center)
        store.bridge = bridge
        store.now = Date(timeIntervalSince1970: 0)
        center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        XCTAssertGreaterThan(store.now, Date(timeIntervalSince1970: 0))
        XCTAssertEqual(bridge.ops, ["direct.licence.get"])
    }

    func testTheClockMovesOnWhenTheTrialDropsADay() throws {
        let (store, _) = store()
        let soon = Date().addingTimeInterval(0.2)
        let days = 3.0
        let endsAt = soon.addingTimeInterval((days - 1) * Licence.dayMs / 1000)
        store.adoptLicence(.object([
            "gated": .bool(true), "state": .string("none"),
            "trial": .object(["state": .string("running"), "endsAt": .number(endsAt.milliseconds)]),
        ]))
        let before = store.now
        let moved = expectation(description: "the clock moved at the day boundary")
        withObservationTracking { _ = store.now } onChange: { moved.fulfill() }
        wait(for: [moved], timeout: 2)
        XCTAssertGreaterThan(store.now, before)
        XCTAssertEqual(try XCTUnwrap(store.licence).row(Date()).label, L10n.phoneSettingsLicenceTrialDays(days: "2"))
    }

    func testWithoutABridgeAnActionFailsWithACode() {
        let store = SettingsStore()
        var failure: String?
        store.run(.licenceRefresh) { if case .failure(let error) = $0 { failure = error.code } }
        XCTAssertEqual(failure, "E_SCREENS_UNAVAILABLE")
    }

    func testSyncNeedsTheOwnerOnlyForTheProblemsTheyMustSolve() {
        let (store, bridge) = store()
        store.load()
        bridge.answer("direct.sync.get", .ok(.object(["enabled": .bool(true)])))
        XCTAssertTrue(store.syncOn)
        XCTAssertFalse(store.syncNeedsOwner)
    }

    func testSyncChangesHeardDuringAReadReadOnceMoreAfterIt() {
        let (store, bridge) = store()
        store.heard(.syncChanged)
        store.heard(.syncChanged)
        store.heard(.syncChanged)
        XCTAssertEqual(bridge.ops, ["direct.sync.get"])
        bridge.answer("direct.sync.get", .ok(.object(["enabled": .bool(true)])))
        XCTAssertEqual(bridge.ops.filter { $0 == "direct.sync.get" }.count, 1)
        bridge.answer("direct.sync.get", .ok(.object(["enabled": .bool(true)])))
        XCTAssertFalse(bridge.ops.contains("direct.sync.get"))
    }

    func testICloudIsReadAgainOnlyWhenWhatItDependsOnChanges() {
        let (store, bridge) = store()
        store.adoptSync(.object(["enabled": .bool(true)]))
        bridge.answer("direct.sync.icloudStatus", .ok(.object(["available": .bool(true), "account": .string("available")])))
        XCTAssertEqual(store.icloud, ICloudStatus(available: true, account: "available"))
        store.adoptSync(.object(["enabled": .bool(true), "status": .object(["lastSync": .number(5)])]))
        XCTAssertTrue(bridge.sent.isEmpty)
        store.adoptSync(.object(["enabled": .bool(false)]))
        XCTAssertEqual(bridge.ops, ["direct.sync.icloudStatus"])
        bridge.answer("direct.sync.icloudStatus", .failed("E_COMMAND_FAILED"))
        XCTAssertEqual(store.icloud, .none)
    }

    func testAPairingNoticeNudgesTheSyncPane() {
        let (store, _) = store()
        store.heard(.syncPairing)
        XCTAssertEqual(store.pairingNudges, 1)
    }

    func testAPatchShowsEveryKeyTellsTheThemeBeforeRustAndRollsBackTogether() {
        let (store, bridge) = store()
        var told: [(sent: Int, editor: [String: JSONValue])] = []
        store.onEditor = { told.append((bridge.sent.count, $0)) }
        store.loadEditor()
        XCTAssertEqual(bridge.ops, ["direct.editorSettings.get"])
        bridge.answer(
            "direct.editorSettings.get",
            editor(1, ["lightTheme": .string("default"), "darkTheme": .string("default")]))
        store.setEditor(["lightTheme": .string("dawn"), "darkTheme": .string("dawn")])
        XCTAssertEqual(told.last?.sent, 0)
        XCTAssertEqual(told.last?.editor["darkTheme"], .string("dawn"))
        XCTAssertEqual(
            bridge.sent.last?.args, ["patch": .object(["lightTheme": .string("dawn"), "darkTheme": .string("dawn")])])
        bridge.answer("direct.editorSettings.set", .failed("E_SETTINGS_WRITE"))
        XCTAssertEqual(store.editor["lightTheme"], .string("default"))
        XCTAssertEqual(told.last?.editor["darkTheme"], .string("default"))
        XCTAssertEqual(bridge.lines, ["W_PHONE_SETTINGS_SAVE_FAILED key=darkTheme,lightTheme code=E_SETTINGS_WRITE"])
    }
}
