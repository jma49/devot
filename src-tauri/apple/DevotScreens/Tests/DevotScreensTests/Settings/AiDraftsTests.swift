import XCTest

@testable import DevotScreens

@MainActor
final class AiDraftsTests: XCTestCase {
    private static func provider(_ endpoint: String, _ model: String) -> JSONValue {
        .object([
            "endpoint": .string(endpoint), "model": .string(model), "defaultEndpoint": .string(""),
            "defaultModel": .string(""), "key": .string("unset"),
        ])
    }

    private static func view(active: String = "anthropic", anthropic: String = "", openai: String = "") -> JSONValue {
        .object([
            "active": .string(active), "suggestOnIdle": .bool(false),
            "anthropic": provider(anthropic, "claude"), "openai": provider(openai, "gpt"),
        ])
    }

    private func drafts() -> (AiDrafts, SettingsStore, FakeBridge) {
        let bridge = FakeBridge()
        let store = SettingsStore()
        store.bridge = bridge
        store.ai = AiView(Self.view())
        let drafts = AiDrafts(store: store)
        drafts.fill()
        return (drafts, store, bridge)
    }

    func testARefusedProviderSwitchKeepsTheEndpointAndModelTyped() {
        let (drafts, store, bridge) = drafts()
        drafts["anthropic"] = AiDrafts.Draft(endpoint: "http://192.168.1.5:11434", model: "local")
        drafts.commit { $0.active = "openai" }
        XCTAssertEqual(store.ai?.active, "openai")
        bridge.answer("direct.ai.set", .failed("E_AI_ENDPOINT_INVALID"))
        XCTAssertEqual(store.ai?.active, "anthropic")
        XCTAssertEqual(store.ai?.anthropic.endpoint, "")
        XCTAssertEqual(drafts["anthropic"], AiDrafts.Draft(endpoint: "http://192.168.1.5:11434", model: "local"))
        XCTAssertEqual(drafts["openai"], AiDrafts.Draft(endpoint: "", model: "gpt"))
        XCTAssertNotNil(store.failure)
    }

    func testAConfirmedChangeShowsWhatRustKeptButNotOverWhatWasTypedMeanwhile() {
        let (drafts, store, bridge) = drafts()
        drafts["anthropic"] = AiDrafts.Draft(endpoint: " https://proxy.example.test ", model: "claude")
        drafts.commit { $0.active = "openai" }
        drafts["openai"] = AiDrafts.Draft(endpoint: "https://gpt.example.test", model: "gpt")
        bridge.answer(
            "direct.ai.set", .ok(Self.view(active: "openai", anthropic: "https://proxy.example.test")))
        XCTAssertEqual(store.ai?.active, "openai")
        XCTAssertEqual(drafts["anthropic"], AiDrafts.Draft(endpoint: "https://proxy.example.test", model: "claude"))
        XCTAssertEqual(drafts["openai"], AiDrafts.Draft(endpoint: "https://gpt.example.test", model: "gpt"))
    }

    func testTheDraftsAreFilledOnceFromTheFirstStoredView() {
        let bridge = FakeBridge()
        let store = SettingsStore()
        store.bridge = bridge
        let drafts = AiDrafts(store: store)
        drafts.fill()
        XCTAssertNil(drafts["anthropic"])
        store.ai = AiView(Self.view(anthropic: "https://one.example.test"))
        drafts.fill()
        drafts["anthropic"]?.model = "typed"
        store.ai = AiView(Self.view(anthropic: "https://two.example.test"))
        drafts.fill()
        XCTAssertEqual(drafts["anthropic"], AiDrafts.Draft(endpoint: "https://one.example.test", model: "typed"))
    }

    private func sentEndpoint(_ bridge: FakeBridge) -> String? {
        bridge.sent.last { $0.op == "direct.ai.set" }?.args["settings"]?["anthropic"]?["endpoint"]?.string
    }

    func testLeavingStoresTheEndpointTypedWithoutReturn() {
        let (drafts, store, bridge) = drafts()
        drafts["anthropic"]?.endpoint = "https://proxy.example.test"
        drafts.commit(skippingRefused: true)
        XCTAssertEqual(sentEndpoint(bridge), "https://proxy.example.test")
        bridge.answer("direct.ai.set", .ok(Self.view(anthropic: "https://proxy.example.test")))
        XCTAssertEqual(store.ai?.anthropic.endpoint, "https://proxy.example.test")
    }

    func testTheSuggestSwitchStoresTheTypedDraftsWithIt() {
        let (drafts, store, bridge) = drafts()
        drafts["anthropic"]?.endpoint = "https://proxy.example.test"
        drafts.commit(skippingRefused: true) { $0.suggestOnIdle = true }
        XCTAssertEqual(sentEndpoint(bridge), "https://proxy.example.test")
        XCTAssertEqual(store.ai?.suggestOnIdle, true)
    }

    func testARefusedDraftIsSentAgainOnlyByReturnOrOnceEdited() {
        let (drafts, store, bridge) = drafts()
        drafts["anthropic"]?.endpoint = "http://192.168.1.5:11434"
        drafts.commit()
        bridge.answer("direct.ai.set", .failed("E_AI_ENDPOINT_INVALID"))
        store.failure = nil
        drafts.commit(skippingRefused: true)
        XCTAssertFalse(bridge.ops.contains("direct.ai.set"))
        drafts.commit(skippingRefused: true) { $0.suggestOnIdle = true }
        XCTAssertEqual(sentEndpoint(bridge), "")
        bridge.answer("direct.ai.set", .ok(Self.view()))
        drafts.commit()
        XCTAssertEqual(sentEndpoint(bridge), "http://192.168.1.5:11434")
        bridge.answer("direct.ai.set", .failed("E_AI_ENDPOINT_INVALID"))
        drafts["anthropic"]?.endpoint = "http://localhost:11434"
        drafts.commit(skippingRefused: true)
        XCTAssertEqual(sentEndpoint(bridge), "http://localhost:11434")
        XCTAssertEqual(drafts["anthropic"]?.endpoint, "http://localhost:11434")
    }
}
