import XCTest

@testable import DevotScreens

@MainActor
final class LicencePaneModelTests: XCTestCase {
    private func model() -> (LicencePaneModel, FakeBridge) {
        let bridge = FakeBridge()
        let store = SettingsStore()
        store.bridge = bridge
        bridge.sent.removeAll()
        return (LicencePaneModel(store: store), bridge)
    }

    private let held: JSONValue = .object(["gated": .bool(true), "state": .string("valid")])

    func testRemoveIsRefusedWhileAReplaceRunsAndOnlyTheReplacesReplyEndsIt() {
        let (model, bridge) = model()
        model.key = "NEW-KEY"
        model.add()
        XCTAssertEqual(model.action, .running(.licenceSet))
        model.remove()
        model.retry()
        XCTAssertEqual(bridge.ops, ["direct.licence.set"])
        XCTAssertTrue(model.busy)
        bridge.answer("direct.licence.set", .ok(held))
        XCTAssertFalse(model.busy)
        XCTAssertEqual(model.announcement, L10n.licenceSettingsAdded())
        XCTAssertEqual(model.key, "")
    }

    func testAnAddIsRefusedWhileARemoveRuns() {
        let (model, bridge) = model()
        model.remove()
        model.key = "NEW-KEY"
        model.add()
        XCTAssertEqual(bridge.ops, ["direct.licence.remove"])
        XCTAssertEqual(model.key, "NEW-KEY")
        bridge.answer("direct.licence.remove", .failed("E_LICENCE_KEYCHAIN"))
        XCTAssertFalse(model.busy)
        XCTAssertNil(model.announcement)
        XCTAssertEqual(model.problem, LicenceText.failure(L10n.licenceSettingsRemoveFailed(), "E_LICENCE_KEYCHAIN"))
        XCTAssertEqual(bridge.lines, ["W_LICENCE_SETTINGS_FAILED op=direct.licence.remove code=E_LICENCE_KEYCHAIN"])
    }
}
