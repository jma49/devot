#if DEBUG
import XCTest

@testable import DevotScreens

private let environment = SpikeEnvironment(device: "iPhone17,1", os: "iOS 26.1", build: "0.9.0 (42)")
private let startedAt = Date(timeIntervalSince1970: 1_800_000_000.25)

private func encoded(_ spike: Spike, _ results: any SpikeResults) throws -> [String: Any] {
    let report = SpikeReport(spike: spike, environment: environment, startedAt: startedAt, results: results)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: try report.json()) as? [String: Any])
}

private func decoded<T: Decodable>(_ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

// What src/renderer/src/phone/screens/spikes.ts answers; spikes.test.ts checks the same shapes.
private let pageWatch = """
    {"hidden":0,"pings":{"sent":200,"answered":200,"missed":0,"maxGapMs":131.5},\
    "viewport":{"resizes":0,"width":402,"height":874},"sync":{"enabled":true,"states":["idle","syncing"]}}
    """
private let pageFocus = #"{"focused":true,"caret":true}"#
private let pageFrames = """
    {"frames":420,"budgetMs":8.33,"medianMs":8.33,"p95Ms":8.5,"maxMs":12,"overBudget":0}
    """
private let pageLayout = #"{"documentHeight":42000,"editorHeight":41900,"lines":1500,"renderedLines":60}"#
private let pageScroll = #"{"scrollY":20563,"rendered":true}"#

private func keyboardTry(up: Bool, field: Bool, web: Bool) throws -> KeyboardTry {
    KeyboardTry(
        keyboardUp: up, keyboardDropped: false, fieldFirstResponder: field, webViewFirstResponder: web,
        page: try decoded(pageFocus))
}

private let keyboardSnapshot = """
    {"stage":"appeared","atMs":812.5,"applicationState":"active","sceneActivationState":"foregroundActive",\
    "connectedScenes":1,"sceneWindows":1,"sceneDelegate":"TaoSceneDelegate","windowClass":"TaoUIWindow",\
    "windowIsKey":false,"sceneKeyWindow":"none","sceneKeyWindowIsFieldWindow":false,"fieldInWindow":true,\
    "fieldFirstResponder":true,"fieldCanBecomeFirstResponder":true,"fieldEnabled":true,\
    "fieldUserInteractionEnabled":true,"fieldAlpha":0,"fieldHasInputView":false,\
    "fieldHasInputAccessoryView":false,"ancestorHidden":false,"ancestorTransparent":false,\
    "hitTestView":"TaoView","hardwareKeyboard":false,"firstResponderInWindow":"UITextField",\
    "firstResponderOfKeyWindow":"none","webViewFirstResponder":false,\
    "contentViewClass":"WKContentView_DevotNoInputAccessory","keyboardUp":false}
    """

private func keyboardDiagnostics(upForTries: Bool = true, madeKey: Bool = false) throws -> KeyboardDiagnostics {
    let snapshot: KeyboardSnapshot = try decoded(keyboardSnapshot)
    let tried = KeyboardTryDiagnostics(
        askedField: false, fieldBecame: nil, webViewBecame: nil, keyboardUpBeforeFocus: true, before: snapshot,
        afterFocus: snapshot, end: snapshot)
    return KeyboardDiagnostics(
        activationWaitMs: 0, activated: true, fieldBecameFirstResponder: true, retriedAfterTransition: false,
        fieldBecameOnRetry: nil, madeKey: madeKey, keyboardUpAfterMakeKey: madeKey ? true : nil, refocused: false,
        fieldBecameOnRefocus: nil, keyboardUpForTries: upForTries, snapshots: [snapshot],
        tries: KeyboardDiagnostics.Tries(
            handOff: tried, handOffThenWebView: tried, webViewThenFocus: tried, caretOnly: tried),
        events: [KeyboardEvent(name: "keyboardWillShow", atMs: 820)])
}

final class SpikeTests: XCTestCase {
    func testEachSpikeIsNamedByItsLaunchArgument() throws {
        XCTAssertEqual(Spike.allCases.map(\.rawValue), ["S1", "S2", "S3", "S4", "barTint"])
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "SpikeTests"))
        defaults.removePersistentDomain(forName: "SpikeTests")
        defer { defaults.removePersistentDomain(forName: "SpikeTests") }
        XCTAssertEqual(Spike.asked(in: defaults), .notAsked)
        defaults.set("S3", forKey: Spike.argument)
        XCTAssertEqual(Spike.asked(in: defaults), .asked(.bridge))
        defaults.set("S9", forKey: Spike.argument)
        XCTAssertEqual(Spike.asked(in: defaults), .unknown)
    }

    func testAReportHasTheAgreedShape() throws {
        let report = try encoded(.barTint, BarTintResults(navigationBar: true, toolbar: true, tabBar: false))
        XCTAssertEqual(
            Set(report.keys), ["spike", "device", "os", "build", "startedAt", "results", "pass", "notes"])
        XCTAssertEqual(report["spike"] as? String, "barTint")
        XCTAssertEqual(report["device"] as? String, "iPhone17,1")
        XCTAssertEqual(report["os"] as? String, "iOS 26.1")
        XCTAssertEqual(report["build"] as? String, "0.9.0 (42)")
        XCTAssertEqual(report["startedAt"] as? String, "2027-01-15T08:00:00.250Z")
        XCTAssertTrue(report["pass"] is NSNull)
        XCTAssertEqual(report["notes"] as? [String], [BarTintResults.screenshotNote])
        let results = try XCTUnwrap(report["results"] as? [String: Any])
        XCTAssertEqual(results["applied"] as? [String: Bool], ["navigationBar": true, "toolbar": true, "tabBar": false])
        XCTAssertEqual(results["colour"] as? String, "phoneActionTrash")
    }

    func testReparentingPassesWhileThePageStaysVisibleAndUnchanged() throws {
        let watch: PageWatch = try decoded(pageWatch)
        let passed = try encoded(.reparenting, ReparentingResults(moves: 200, sizeChanges: 0, page: watch))
        XCTAssertEqual(passed["pass"] as? Bool, true)
        XCTAssertEqual(passed["notes"] as? [String], [])
        let results = try XCTUnwrap(passed["results"] as? [String: Any])
        XCTAssertEqual(Set(results.keys), ["moves", "sizeChanges", "page"])
        let page = try XCTUnwrap(results["page"] as? [String: Any])
        XCTAssertEqual(Set(page.keys), ["hidden", "pings", "viewport", "sync"])

        let resized = try encoded(.reparenting, ReparentingResults(moves: 200, sizeChanges: 1, page: watch))
        XCTAssertEqual(resized["pass"] as? Bool, false)
        let missed: PageWatch = try decoded(pageWatch.replacingOccurrences(of: #""missed":0"#, with: #""missed":3"#))
        XCTAssertEqual(ReparentingResults(moves: 200, sizeChanges: 0, page: missed).pass, false)
        let hidden: PageWatch = try decoded(pageWatch.replacingOccurrences(of: #""hidden":0"#, with: #""hidden":1"#))
        XCTAssertEqual(ReparentingResults(moves: 200, sizeChanges: 0, page: hidden).pass, false)
    }

    func testReparentingSaysWhenNoSyncRan() throws {
        let idle: PageWatch = try decoded(pageWatch.replacingOccurrences(of: #","syncing""#, with: ""))
        let report = try encoded(.reparenting, ReparentingResults(moves: 200, sizeChanges: 0, page: idle))
        XCTAssertEqual(report["notes"] as? [String], [ReparentingResults.noSyncNote])
    }

    func testTheKeyboardSpikePassesOnlyWhenAHandOffKeepsTheKeyboardAndTheCaret() throws {
        let works = try keyboardTry(up: true, field: false, web: true)
        let stuck = try keyboardTry(up: true, field: true, web: false)
        let caretOnly = try keyboardTry(up: false, field: false, web: true)
        let diagnostics = try keyboardDiagnostics()
        let results = { (handOff: KeyboardTry, thenWebView: KeyboardTry, webViewFirst: KeyboardTry) in
            KeyboardResults(
                nativeField: true, handOff: handOff, handOffThenWebView: thenWebView, webViewThenFocus: webViewFirst,
                caretOnly: caretOnly, diagnostics: diagnostics)
        }
        let report = try encoded(.keyboard, results(works, works, works))
        XCTAssertEqual(report["pass"] as? Bool, true)
        XCTAssertEqual(report["notes"] as? [String], [])
        let encodedResults = try XCTUnwrap(report["results"] as? [String: Any])
        XCTAssertEqual(
            Set(encodedResults.keys),
            ["nativeField", "handOff", "handOffThenWebView", "webViewThenFocus", "caretOnly", "diagnostics"])
        let handOff = try XCTUnwrap(encodedResults["handOff"] as? [String: Any])
        XCTAssertEqual(
            Set(handOff.keys),
            ["keyboardUp", "keyboardDropped", "fieldFirstResponder", "webViewFirstResponder", "page"])

        XCTAssertEqual(results(stuck, works, stuck).pass, true)
        XCTAssertEqual(results(stuck, stuck, works).pass, true)
        let neither = results(stuck, stuck, stuck)
        XCTAssertEqual(neither.pass, false)
        XCTAssertEqual(neither.notes, [KeyboardResults.noHandOffNote])
    }

    func testTheKeyboardSpikeReportsUIKitsStateUnderDiagnostics() throws {
        let tried = try keyboardTry(up: true, field: false, web: true)
        let report = try encoded(
            .keyboard,
            KeyboardResults(
                nativeField: true, handOff: tried, handOffThenWebView: tried, webViewThenFocus: tried,
                caretOnly: tried, diagnostics: try keyboardDiagnostics()))
        let results = try XCTUnwrap(report["results"] as? [String: Any])
        let diagnostics = try XCTUnwrap(results["diagnostics"] as? [String: Any])
        XCTAssertEqual(
            Set(diagnostics.keys),
            [
                "activationWaitMs", "activated", "fieldBecameFirstResponder", "retriedAfterTransition", "madeKey",
                "refocused", "keyboardUpForTries", "snapshots", "tries", "events",
            ])
        let tries = try XCTUnwrap(diagnostics["tries"] as? [String: [String: Any]])
        XCTAssertEqual(Set(tries.keys), ["handOff", "handOffThenWebView", "webViewThenFocus", "caretOnly"])
        XCTAssertEqual(
            Set(try XCTUnwrap(tries["handOff"]).keys),
            ["askedField", "keyboardUpBeforeFocus", "before", "afterFocus", "end"])
        let snapshot = try XCTUnwrap((diagnostics["snapshots"] as? [[String: Any]])?.first)
        XCTAssertEqual(snapshot["windowIsKey"] as? Bool, false)
        XCTAssertEqual(snapshot["firstResponderInWindow"] as? String, "UITextField")
        XCTAssertEqual(snapshot["sceneKeyWindow"] as? String, "none")
        XCTAssertEqual(snapshot.count, 28)
        let events = try XCTUnwrap(diagnostics["events"] as? [[String: Any]])
        XCTAssertEqual(events.map { $0["name"] as? String }, ["keyboardWillShow"])
        XCTAssertEqual(events.map { $0["atMs"] as? Double }, [820])
    }

    func testTheKeyboardSpikeSaysWhenTheKeyboardNeverCameUpOrNeededAKeyWindow() throws {
        let down = try keyboardTry(up: false, field: true, web: false)
        let never = KeyboardResults(
            nativeField: false, handOff: down, handOffThenWebView: down, webViewThenFocus: down, caretOnly: down,
            diagnostics: try keyboardDiagnostics(upForTries: false))
        XCTAssertEqual(never.pass, false)
        XCTAssertEqual(never.notes, [KeyboardResults.noKeyboardNote])

        let works = try keyboardTry(up: true, field: false, web: true)
        let afterKey = KeyboardResults(
            nativeField: false, handOff: works, handOffThenWebView: down, webViewThenFocus: down, caretOnly: down,
            diagnostics: try keyboardDiagnostics(madeKey: true))
        XCTAssertEqual(afterKey.pass, true)
        XCTAssertEqual(afterKey.notes, [KeyboardResults.notKeyNote])
    }

    func testThePageSaysWhereItsFocusIsWhenItKnows() throws {
        let page: PageFocus = try decoded(
            #"{"focused":true,"caret":true,"active":"editor","activeTag":"DIV","documentFocused":false}"#)
        XCTAssertEqual(page.active, "editor")
        XCTAssertEqual(page.activeTag, "DIV")
        XCTAssertEqual(page.documentFocused, false)
        let older: PageFocus = try decoded(pageFocus)
        XCTAssertNil(older.active)
    }

    func testTheBridgeSpikeHoldsTheRoundTripBudget() throws {
        let fast = Timings(ms: Array(repeating: 2, count: 990) + Array(repeating: 9, count: 10), failed: 0)
        XCTAssertEqual(fast, Timings(count: 1000, failed: 0, p50Ms: 2, p95Ms: 2, maxMs: 9))
        let frames: PageFrames = try decoded(pageFrames)
        let excerpts = Timings(ms: [3, 4, 5], failed: 3)
        let passed = BridgeResults(
            pings: fast, excerpts: excerpts, excerptCodes: ["E_SCREENS_OP_UNSUPPORTED"], scroll: frames)
        let report = try encoded(.bridge, passed)
        XCTAssertEqual(report["pass"] as? Bool, true)
        let results = try XCTUnwrap(report["results"] as? [String: Any])
        XCTAssertEqual(Set(results.keys), ["pings", "excerpts", "excerptCodes", "scroll"])
        let pings = try XCTUnwrap(results["pings"] as? [String: Any])
        XCTAssertEqual(Set(pings.keys), ["count", "failed", "p50Ms", "p95Ms", "maxMs"])
        XCTAssertEqual(
            report["notes"] as? [String], [BridgeResults.hitchesNote, BridgeResults.unsupportedExcerptsNote])

        let slow = Timings(ms: Array(repeating: 5, count: 100), failed: 0)
        XCTAssertEqual(BridgeResults(pings: slow, excerpts: excerpts, excerptCodes: [], scroll: frames).pass, false)
        let tail = Timings(ms: Array(repeating: 1, count: 90) + Array(repeating: 11, count: 10), failed: 0)
        XCTAssertEqual(BridgeResults(pings: tail, excerpts: excerpts, excerptCodes: [], scroll: frames).pass, false)
        let lost = Timings(ms: [1, 1], failed: 1)
        XCTAssertEqual(BridgeResults(pings: lost, excerpts: excerpts, excerptCodes: [], scroll: frames).pass, false)
        let hitched: PageFrames = try decoded(pageFrames.replacingOccurrences(of: #""overBudget":0"#, with: #""overBudget":2"#))
        XCTAssertEqual(BridgeResults(pings: fast, excerpts: excerpts, excerptCodes: [], scroll: hitched).pass, false)
    }

    func testPercentilesTakeTheNearestRank() {
        XCTAssertNil(SpikeStats.percentile([], 50))
        XCTAssertEqual(SpikeStats.percentile([7], 95), 7)
        XCTAssertEqual(SpikeStats.percentile([4, 1, 3, 2], 50), 2)
        XCTAssertEqual(SpikeStats.percentile(Array(1...100).map(Double.init), 95), 95)
        XCTAssertEqual(SpikeStats.percentile([1, 2, 3], 100), 3)
        XCTAssertEqual(Timings(ms: [], failed: 2), Timings(count: 0, failed: 2, p50Ms: 0, p95Ms: 0, maxMs: 0))
        XCTAssertEqual(Timings(ms: [1.23456], failed: 0).p50Ms, 1.23)
    }

    func testTheScrollerSpikePassesWhenTheWebViewScrollsTheWholeNote() throws {
        let layout: PageLayout = try decoded(pageLayout)
        let scroll: PageScroll = try decoded(pageScroll)
        let view = ScrollViewMeasure(
            contentHeight: 42001, boundsHeight: 874, scrollEnabled: true, keyboardDismissInteractive: true,
            edgeEffectSet: true)
        let passed = ScrollerResults(
            scrollView: view, page: layout, middle: ScrollProbe(offset: 20563, page: scroll),
            end: ScrollProbe(offset: 41127, page: PageScroll(scrollY: 41127, rendered: true)))
        let report = try encoded(.scroller, passed)
        XCTAssertEqual(report["pass"] as? Bool, true)
        XCTAssertEqual(report["notes"] as? [String], [ScrollerResults.screenshotNote])
        let results = try XCTUnwrap(report["results"] as? [String: Any])
        XCTAssertEqual(Set(results.keys), ["scrollView", "page", "middle", "end"])

        let short = ScrollViewMeasure(
            contentHeight: 874, boundsHeight: 874, scrollEnabled: true, keyboardDismissInteractive: true,
            edgeEffectSet: true)
        XCTAssertEqual(
            ScrollerResults(scrollView: short, page: layout, middle: passed.middle, end: passed.end).pass, false)
        let blank = ScrollProbe(offset: 20563, page: PageScroll(scrollY: 20563, rendered: false))
        XCTAssertEqual(ScrollerResults(scrollView: view, page: layout, middle: blank, end: passed.end).pass, false)
        let apart = ScrollProbe(offset: 20563, page: PageScroll(scrollY: 0, rendered: true))
        XCTAssertEqual(ScrollerResults(scrollView: view, page: layout, middle: apart, end: passed.end).pass, false)
    }

    func testARunThatFailsBeforeMeasuringSaysWhy() throws {
        let report = try encoded(.scroller, FailedRun(code: "E_SPIKE_PAGE_TIMEOUT"))
        XCTAssertEqual(report["pass"] as? Bool, false)
        XCTAssertEqual(report["notes"] as? [String], ["E_SPIKE_PAGE_TIMEOUT"])
        XCTAssertEqual((report["results"] as? [String: Any])?.count, 0)
    }

    func testSyntheticNoteIDsAreVersionSevenUUIDs() {
        let ids = SpikeHarness.syntheticNoteIDs(3)
        XCTAssertEqual(ids.count, 3)
        XCTAssertEqual(Set(ids).count, 3)
        for id in ids {
            let uuid = UUID(uuidString: id)
            XCTAssertNotNil(uuid)
            XCTAssertEqual(uuid?.uuidString.lowercased(), id)
            XCTAssertEqual(Array(id)[14], "7")
        }
    }
}
#endif
