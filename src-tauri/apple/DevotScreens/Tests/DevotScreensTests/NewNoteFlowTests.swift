import UIKit
import XCTest

@testable import DevotScreens

private let made = "01970000-0000-7000-8000-0000000000a1"
private let book = "01970000-0000-7000-8000-0000000000b1"

/// New Note from the page's list through the gate, the push, the create and the discard, with a
/// stand-in web view and Rust (docs/specs/iphone-screens.md, New Note).
@MainActor
final class NewNoteFlowTests: XCTestCase {
    private var window: UIWindow?
    private var rust: FakeRust!
    private var screens: Screens!
    private var answered = Set<UInt64>()

    override func setUp() async throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        self.window = window
        let tao = UIViewController()
        let webView = RecordingWebView()
        tao.view.addSubview(webView)
        rust = FakeRust()
        screens = try XCTUnwrap(
            Screens.attach(webView: webView, root: tao, rust: rust, defaults: try freshDefaults()))
        window.rootViewController = tao
        window.makeKeyAndVisible()
        webView.frame = window.bounds
        tao.view.layoutIfNeeded()
        settle()
        answerAll()
    }

    override func tearDown() async throws {
        screens.root.tabs.presentedViewController?.dismiss(animated: false)
        window?.endEditing(true)
        settle(0.5)
        window?.isHidden = true
        window = nil
        screens = nil
        rust = nil
    }

    private func settle(_ seconds: TimeInterval = 0.05) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    /// Runs the run loop until the condition holds, for a step that waits on the system's push and pop.
    private func settle(
        until condition: () throws -> Bool, timeout: TimeInterval = 30, file: StaticString = #filePath,
        line: UInt = #line
    ) rethrows {
        let deadline = Date().addingTimeInterval(timeout)
        while try !condition(), Date() < deadline { settle(0.02) }
        if try !condition() { XCTFail("waited \(timeout) s and the condition never held", file: file, line: line) }
    }

    private var navigation: UINavigationController {
        screens.root.tabs.selectedViewController as! UINavigationController
    }

    private func sent() throws -> [(UInt64, Message)] {
        try rust.calls.map { ($0.0, try Message(json: $0.1)) }
    }

    private func requests() throws -> [(op: Op, args: [String: JSONValue])] {
        try sent().compactMap { _, message in
            guard case .request(_, let op, let args) = message else { return nil }
            return (op, args)
        }
    }

    private func answer(_ op: Op, _ outcome: Outcome) throws {
        let (id, _) = try XCTUnwrap(
            try sent().last { id, message in
                guard case .request(_, op, _) = message else { return false }
                return !answered.contains(id)
            })
        answered.insert(id)
        screens.replied(id, try Message.reply(id: id, outcome: outcome).json())
    }

    /// Whatever else waits gets an empty answer: tab, editor and settings requests, and list reads.
    private func answerAll(_ result: JSONValue = .object([:])) {
        for (id, json) in rust.calls where !answered.contains(id) {
            answered.insert(id)
            let answer = FakeRust.emptyAnswer(json, request: result)
            screens.replied(id, try? Message.reply(id: id, outcome: .ok(answer)).json())
        }
    }

    private func deliver(_ json: String) {
        screens.delivered(Data(json.utf8))
    }

    private func adopt(_ licence: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: licence)
        screens.root.tabs.settings.store.adoptLicence(try JSONDecoder().decode(JSONValue.self, from: data))
    }

    private let keyBuildEnded: [String: Any] = [
        "gated": true, "state": "none", "trial": ["state": "ended", "endsAt": 1000],
    ]

    func testAnUnlockedNewNotePushesAtOnceThenCreatesThenShowsTheNoteForTyping() throws {
        deliver(#"{"v":1,"notice":"note.new","bookId":"\#(book)"}"#)
        let screen = try XCTUnwrap(navigation.topViewController as? EditorScreen)
        XCTAssertTrue(screen.isNew)
        XCTAssertNil(screen.noteId)
        settle()
        XCTAssertTrue(screen.cover.waiting, "until the note exists, the cover holds")
        // The Settings start's own requests may follow in a later turn.
        let create = try XCTUnwrap(try requests().last { $0.op == .noteCreate })
        XCTAssertEqual(create.args, ["bookId": .string(book)])

        try answer(.noteCreate, .ok(.object(["id": .string(made), "rev": .number(3)])))
        XCTAssertEqual(screen.noteId, made)
        settle(1)
        let shows = try requests().filter { $0.op == .editorShow }
        XCTAssertEqual(shows.map(\.args), [["noteId": .string(made), "focus": .string("body")]])
        XCTAssertEqual(try requests().last?.op, .editorFocus, "the caret is asked for once the push has landed")
        XCTAssertEqual(try requests().filter { $0.op == .editorFocus }.count, 1)
        XCTAssertEqual(rust.lines.filter { $0.hasPrefix("W_") }, [])
    }

    func testANewNoteWithoutANotebookAsksForAnUnfiledOne() throws {
        deliver(#"{"v":1,"notice":"note.new"}"#)
        XCTAssertEqual(try requests().last?.op, .noteCreate)
        XCTAssertEqual(try requests().last?.args, [:])
    }

    func testALockedSnapshotShowsTheSurfaceAndPushesNothing() throws {
        let recorder = HapticRecorder()
        screens.haptics.make = recorder.make
        try adopt(keyBuildEnded)
        deliver(#"{"v":1,"notice":"note.new"}"#)
        XCTAssertEqual(recorder.log.filter { $0.hasSuffix("occurred") }, ["warning.occurred"], "the warning plays once")
        XCTAssertEqual(recorder.log.last, "warning.occurred")
        XCTAssertEqual(recorder.log.first, "warning.prepare")
        XCTAssertFalse(navigation.topViewController is EditorScreen)
        XCTAssertFalse(try requests().contains { $0.op == .noteCreate })
        XCTAssertTrue(screens.root.tabs.presentedViewController is ContentSheetController)
        XCTAssertEqual(screens.gate.holding, .newNote(bookId: nil))
        deliver(#"{"v":1,"notice":"note.new"}"#)
        settle(1)
        XCTAssertTrue(screens.root.tabs.presentedViewController is ContentSheetController, "one sheet per decision")
    }

    func testARefusedCreatePopsUnderTheCoverThenShowsTheSurface() throws {
        deliver(#"{"v":1,"notice":"note.new"}"#)
        let screen = try XCTUnwrap(navigation.topViewController as? EditorScreen)
        try answer(.noteCreate, .failed(ProGate.required))
        XCTAssertFalse(screen.cover.isHidden)
        XCTAssertEqual(screen.cover.alpha, 1)
        XCTAssertFalse(try requests().contains { $0.op == .editorShow }, "no editor was ever shown")
        let licenceRead = {
            try self.sent().last { _, message in
                if case .direct(_, .licenceGet, _) = message { true } else { false }
            }
        }
        try settle(until: { try licenceRead() != nil })
        XCTAssertNil(navigation.transitionCoordinator, "the read waits for the pop to end")
        XCTAssertFalse(navigation.viewControllers.contains(screen))
        XCTAssertNil(screens.root.tabs.presentedViewController, "the surface waits for the licence read")
        let read = try XCTUnwrap(try licenceRead())
        let licence = try JSONDecoder().decode(
            JSONValue.self, from: try JSONSerialization.data(withJSONObject: keyBuildEnded))
        answered.insert(read.0)
        screens.replied(read.0, try Message.reply(id: read.0, outcome: .ok(licence)).json())
        XCTAssertTrue(screens.root.tabs.presentedViewController is ContentSheetController)
        XCTAssertNil(screens.gate.holding, "a refused write is not run again after an unlock")
        XCTAssertEqual(rust.lines, ["W_PHONE_WRITE_LOCKED op=note.create code=E_LICENCE_REQUIRED"])
    }

    func testAnotherRefusalPopsWithoutASurface() throws {
        deliver(#"{"v":1,"notice":"note.new"}"#)
        try answer(.noteCreate, .failed("E_STORAGE_FULL"))
        settle(1.5)
        XCTAssertFalse(navigation.topViewController is EditorScreen)
        XCTAssertNil(screens.root.tabs.presentedViewController)
        XCTAssertEqual(rust.lines, ["W_PHONE_NEW_NOTE_FAILED code=E_STORAGE_FULL"])
    }

    private func pushNewNote() throws -> EditorScreen {
        deliver(#"{"v":1,"notice":"note.new"}"#)
        let screen = try XCTUnwrap(navigation.topViewController as? EditorScreen)
        try answer(.noteCreate, .ok(.object(["id": .string(made), "rev": .number(3)])))
        settle(1)
        answerAll(.object(["focused": .bool(true)]))
        return screen
    }

    private var discards: [[String: JSONValue]] {
        get throws { try requests().filter { $0.op == .noteDiscard }.map(\.args) }
    }

    func testAnUntouchedNewNoteIsDiscardedAsItsPopEndsBeforeTheListIsShown() throws {
        _ = try pushNewNote()
        deliver(#"{"v":1,"notice":"notes.changed","rev":3,"ids":["\#(made)"]}"#)
        navigation.popViewController(animated: true)
        XCTAssertEqual(try discards, [])
        settle(1)
        XCTAssertEqual(try discards, [["noteId": .string(made)]])
        let ops = try requests().map(\.op)
        let discard = try XCTUnwrap(ops.lastIndex(of: .noteDiscard))
        XCTAssertEqual(ops.lastIndex(of: .editorHide).map { $0 > discard }, true, "the row goes before the hide")
        answerAll()
        settle(1)
        XCTAssertEqual(try discards.count, 1)
    }

    func testANewNoteChangedSinceItWasMadeIsKept() throws {
        _ = try pushNewNote()
        deliver(#"{"v":1,"notice":"notes.changed","rev":4,"ids":["\#(made)"]}"#)
        navigation.popViewController(animated: true)
        settle(1)
        answerAll()
        settle(0.5)
        XCTAssertEqual(try discards, [])
    }

    func testABackSwipeTurnedBackKeepsTheNewNote() throws {
        let screen = try pushNewNote()
        let swipe = HeldPop()
        navigation.delegate = swipe
        navigation.popViewController(animated: true)
        settle()
        swipe.interaction.update(0.5)
        settle()
        swipe.interaction.cancel()
        settle(1)
        navigation.delegate = nil
        XCTAssertTrue(navigation.topViewController === screen)
        XCTAssertEqual(try discards, [])
    }

    func testANoteMadeAfterItsScreenWentIsDiscardedAtOnce() throws {
        deliver(#"{"v":1,"notice":"note.new"}"#)
        settle(1)
        navigation.popViewController(animated: true)
        settle(1)
        XCTAssertEqual(try discards, [])
        try answer(.noteCreate, .ok(.object(["id": .string(made), "rev": .number(3)])))
        XCTAssertEqual(try discards, [["noteId": .string(made)]])
    }

    private func answerLicenceRead(_ licence: [String: Any]) throws {
        let read = try XCTUnwrap(
            try sent().last { id, message in
                if case .direct(_, .licenceGet, _) = message { !answered.contains(id) } else { false }
            })
        let value = try JSONDecoder().decode(JSONValue.self, from: try JSONSerialization.data(withJSONObject: licence))
        answered.insert(read.0)
        screens.replied(read.0, try Message.reply(id: read.0, outcome: .ok(value)).json())
    }

    func testALicenceChangeThatUnlocksUnderTheSheetClosesItAndMakesTheNoteOnce() throws {
        try adopt(keyBuildEnded)
        deliver(#"{"v":1,"notice":"note.new"}"#)
        settle(1)
        XCTAssertTrue(screens.root.tabs.presentedViewController is ContentSheetController)
        deliver(#"{"v":1,"notice":"licence.changed"}"#)
        try answerLicenceRead(["gated": true, "state": "valid", "id": "lic_1"])
        settle(1.5)
        XCTAssertNil(screens.root.tabs.presentedViewController, "the sheet closes on its own")
        try answerLicenceRead(["gated": true, "state": "valid", "id": "lic_1"])
        XCTAssertEqual(try requests().filter { $0.op == .noteCreate }.count, 1)
        XCTAssertTrue(navigation.topViewController is EditorScreen)
    }

    func testALicenceChangeThatStillLocksKeepsTheSheet() throws {
        try adopt(keyBuildEnded)
        deliver(#"{"v":1,"notice":"note.new"}"#)
        settle(1)
        deliver(#"{"v":1,"notice":"licence.changed"}"#)
        try answerLicenceRead(keyBuildEnded)
        settle(1)
        XCTAssertTrue(screens.root.tabs.presentedViewController is ContentSheetController)
        XCTAssertEqual(screens.gate.holding, .newNote(bookId: nil))
    }

    func testRustsLicenceChangeReadsTheSnapshotAgain() throws {
        deliver(#"{"v":1,"notice":"licence.changed"}"#)
        XCTAssertTrue(
            try sent().contains { _, message in
                if case .direct(_, .licenceGet, _) = message { true } else { false }
            })
    }
}
