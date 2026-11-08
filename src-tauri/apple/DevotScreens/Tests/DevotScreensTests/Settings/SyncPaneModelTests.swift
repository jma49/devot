import XCTest

@testable import DevotScreens

@MainActor
final class SyncPaneModelTests: XCTestCase {
    private func model(_ snapshot: [String: JSONValue] = [:]) -> (SyncPaneModel, FakeBridge) {
        let bridge = FakeBridge()
        let store = SettingsStore()
        store.bridge = bridge
        store.adoptSync(.object(snapshot))
        bridge.sent.removeAll()
        return (SyncPaneModel(store: store), bridge)
    }

    private let relayVault: [String: JSONValue] = [
        "relayUrl": .string("https://relay.example.test"), "enabled": .bool(true), "vault": .bool(true),
        "enrolled": .bool(true), "status": .object(["state": .string("idle")]),
    ]

    private let shown: JSONValue = .object([
        "code": .string("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ01-2345"), "link": .string("devot://pair?code=x"),
        "qr": .object(["size": .number(1), "modules": .string("1")]), "expires": .number(4_000_000_000_000),
    ])

    private func pairing(_ model: SyncPaneModel, _ bridge: FakeBridge) {
        model.showPairing()
        bridge.answer("direct.sync.pairingOpen", .ok(shown))
    }

    func testAPairingWaitsThenTellsOfTheNewDeviceAndReadsTheDevicesAgain() throws {
        let (model, bridge) = model(relayVault)
        pairing(model, bridge)
        XCTAssertEqual(model.pairing?.modules, [true])
        model.checkPairing()
        bridge.answer("direct.sync.pairingCheck", .ok(.object(["state": .string("taken")])))
        XCTAssertEqual(model.progressText, catalog("syncSettings.pairTaken"))
        model.checkPairing()
        bridge.answer("direct.sync.pairingCheck", .ok(.object(["state": .string("paired"), "device": .string("d1")])))
        XCTAssertNil(model.pairing)
        XCTAssertEqual(model.announcement, catalog("syncSettings.pairDone"))
        XCTAssertTrue(bridge.ops.contains("direct.sync.devices"))
    }

    func testAPairingEndsWhenThePaneLeavesTheStack() {
        let (model, bridge) = model(relayVault)
        pairing(model, bridge)
        model.left()
        XCTAssertNil(model.pairing)
        XCTAssertTrue(bridge.ops.contains("direct.sync.pairingCancel"))
    }

    func testAPairingThatOpensAfterThePaneLeftIsCancelledAndNotShown() {
        let (model, bridge) = model(relayVault)
        model.showPairing()
        model.left()
        bridge.answer("direct.sync.pairingOpen", .ok(shown))
        XCTAssertNil(model.pairing)
        XCTAssertEqual(bridge.ops, ["direct.sync.pairingCancel"])
    }

    func testARelayTypedButNotSubmittedIsSavedBeforeJoining() {
        let (model, bridge) = model()
        model.url = "https://relay.example.test"
        model.code = "ABCD-EFGH"
        model.join(recovery: false, icloud: false)
        XCTAssertEqual(bridge.ops, ["direct.sync.set"])
        XCTAssertEqual(bridge.sent.first?.args, ["patch": .object(["relayUrl": .string("https://relay.example.test")])])
        bridge.answer("direct.sync.set", .ok(.object(["relayUrl": .string("https://relay.example.test")])))
        XCTAssertNil(model.url)
        XCTAssertEqual(bridge.sent.first { $0.op == "direct.sync.joinCode" }?.args, ["code": .string("ABCD-EFGH")])
    }

    func testARelayTypedButNotSubmittedIsSavedBeforeCreatingAndWhenThePaneLeaves() {
        let (model, bridge) = model(["relayUrl": .string("https://old.example.test")])
        model.url = "https://relay.example.test"
        model.secret = "s3cret"
        model.create()
        XCTAssertEqual(bridge.ops, ["direct.sync.set"])
        bridge.answer("direct.sync.set", .ok(.object(["relayUrl": .string("https://relay.example.test")])))
        XCTAssertEqual(bridge.ops, ["direct.sync.vaultCreate"])
        model.url = "https://other.example.test"
        model.left()
        XCTAssertEqual(bridge.sent.last?.args, ["patch": .object(["relayUrl": .string("https://other.example.test")])])
    }

    func testARelaySubmittedAndLeftAtOnceIsSavedOnce() {
        let (model, bridge) = model()
        model.url = "https://relay.example.test"
        model.saveUrl()
        model.saveUrl()
        XCTAssertEqual(bridge.ops, ["direct.sync.set"])
    }

    func testChangingTheSetupKeepsATypedRelay() {
        let (model, bridge) = model()
        model.choose(.first)
        model.url = "https://relay.example.test"
        model.backOut()
        XCTAssertNil(model.path)
        XCTAssertEqual(bridge.sent.first?.args, ["patch": .object(["relayUrl": .string("https://relay.example.test")])])
    }

    func testARelayOutOfReachKeepsThePairingAndAnyOtherFailureEndsIt() {
        let (model, bridge) = model(relayVault)
        pairing(model, bridge)
        model.checkPairing()
        bridge.answer("direct.sync.pairingCheck", .failed("E_SYNC_OFFLINE"))
        XCTAssertNotNil(model.pairing)
        XCTAssertEqual(model.progressText, catalog("syncSettings.pairRetrying"))
        model.checkPairing()
        bridge.answer("direct.sync.pairingCheck", .failed("E_SYNC_PAIRING_AUTH"))
        XCTAssertNil(model.pairing)
        XCTAssertTrue(bridge.ops.contains("direct.sync.pairingCancel"))
        XCTAssertEqual(
            model.problem, "\(catalog("syncSettings.pairCheckFailed")) \(catalog("syncSettings.why.codeRefused"))")
        XCTAssertEqual(bridge.lines, ["W_SYNC_SETTINGS_FAILED op=direct.sync.pairingCheck code=E_SYNC_PAIRING_AUTH"])
    }

    func testALinkThatNamesARelayAsksBeforeSettingItThenJoins() {
        let (model, bridge) = model()
        model.code = "devot://pair?code=ABCD&relay=https%3A%2F%2Frelay.example.test"
        model.join(recovery: false, icloud: false)
        XCTAssertEqual(model.confirm, .linkRelay("https://relay.example.test"))
        XCTAssertTrue(bridge.sent.isEmpty)
        model.confirm = nil
        model.joinOnRelay("https://relay.example.test")
        XCTAssertEqual(bridge.sent.first?.args, ["patch": .object(["relayUrl": .string("https://relay.example.test")])])
        bridge.answer("direct.sync.set", .ok(.object(["relayUrl": .string("https://relay.example.test")])))
        XCTAssertEqual(bridge.sent.first { $0.op == "direct.sync.joinCode" }?.args, ["code": .string(model.code)])
        bridge.answer("direct.sync.joinCode", .ok(.object(relayVault)))
        XCTAssertEqual(model.code, "")
        XCTAssertEqual(model.announcement, catalog("syncSettings.joined"))
    }

    func testALinkToAnUnsafeRelayIsRefusedWithoutAsking() {
        let (model, bridge) = model()
        model.code = "devot://pair?code=ABCD&relay=http%3A%2F%2Frelay.example.test"
        model.join(recovery: false, icloud: false)
        XCTAssertNil(model.confirm)
        XCTAssertTrue(bridge.sent.isEmpty)
        XCTAssertEqual(model.problem, "\(catalog("syncSettings.joinFailed")) \(catalog("syncSettings.why.relayInvalid"))")
    }

    func testJoiningICloudsVaultByKeyGoesThroughICloud() {
        let (model, bridge) = model()
        model.recovery = "ABCDE-FGHIJ"
        model.join(recovery: true, icloud: true)
        XCTAssertEqual(bridge.sent.map(\.op), ["direct.sync.icloudUse"])
        XCTAssertEqual(bridge.sent.first?.args, ["recoveryKey": .string("ABCDE-FGHIJ")])
    }

    func testRemovingADeviceShowsTheDevicesLeft() {
        let (model, bridge) = model(relayVault)
        let device = SyncDevice(id: "d2", label: "Pocket", created: 0, current: false, unseen: false)
        model.remove(device)
        XCTAssertTrue(model.removing.contains("d2"))
        XCTAssertEqual(bridge.sent.first?.args, ["device": .string("d2")])
        bridge.answer(
            "direct.sync.deviceRemove",
            .ok(.array([.object(["id": .string("d1"), "label": .string("Studio"), "created": .number(1), "current": .bool(true)])])))
        XCTAssertEqual(model.devices?.map(\.id), ["d1"])
        XCTAssertTrue(model.removing.isEmpty)
        XCTAssertEqual(model.announcement, catalog("syncSettings.deviceRemoved"))
    }

    func testTheRecoveryKeyIsCopiedLocallyAndGoesOnceSaved() {
        let (model, bridge) = model(relayVault)
        var copied: [String] = []
        model.copy = { copied.append($0) }
        model.recoveryKey = "ABCDE-FGHIJ"
        model.copyRecoveryKey()
        XCTAssertEqual(copied, ["ABCDE-FGHIJ"])
        model.recoverySaved()
        bridge.answer("direct.sync.recoverySaved", .ok(.null))
        XCTAssertNil(model.recoveryKey)
    }

    func testAConfirmedICloudActionAsksFirstAndRunsOnceTheAlertHasClosed() {
        let (model, bridge) = model()
        model.act(.uploadAgain)
        XCTAssertEqual(model.confirm, .icloud(.uploadAgain))
        XCTAssertTrue(bridge.sent.isEmpty)
        model.confirm = nil
        model.perform(.uploadAgain)
        XCTAssertNil(model.confirm)
        XCTAssertEqual(bridge.ops, ["direct.sync.icloudUploadAgain"])
        model.act(.turnOff)
        XCTAssertEqual(bridge.sent.last?.args, ["patch": .object(["enabled": .bool(false)])])
    }

    func testOpeningAVaultReadsItsKeyDevicesAndUsage() {
        let (model, bridge) = model(relayVault)
        model.changed(from: nil)
        XCTAssertEqual(Set(bridge.ops), ["direct.sync.recoveryKey", "direct.sync.devices", "direct.sync.usage"])
        bridge.answer("direct.sync.usage", .failed("E_SYNC_BAD_MESSAGE"))
        XCTAssertEqual(model.usage, .failed(code: "E_SYNC_BAD_MESSAGE"))
        XCTAssertEqual(bridge.lines, ["W_SYNC_USAGE_FAILED code=E_SYNC_BAD_MESSAGE"])
    }
}
