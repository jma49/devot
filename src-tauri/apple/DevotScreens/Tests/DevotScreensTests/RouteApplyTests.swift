import UIKit
import XCTest

@testable import DevotScreens

private let note = "01970000-0000-7000-8000-0000000000c1"

/// A deep link's route as Rust sends it, shown on the native screens (docs/specs/iphone-screens.md, Routes).
@MainActor
final class RouteApplyTests: XCTestCase {
    private var harness: ScreensHarness!

    override func setUp() async throws {
        harness = try ScreensHarness(defaults: try freshDefaults())
        harness.settle()
        harness.answerAll()
    }

    override func tearDown() async throws {
        harness.close()
        harness = nil
    }

    private var screens: Screens { harness.screens }

    private let noteRoute = #"{"v":1,"notice":"route","route":"stack","tab":"notes","stack":[{"kind":"editor","noteId":"\#(note)"}]}"#

    func testANoteLinkInFrontShowsTheNoteOverTheNotesListWithTheSystemPush() throws {
        screens.inFront = { true }
        harness.deliver(noteRoute)
        XCTAssertEqual(harness.directs().last?.op, .listsTitles)
        XCTAssertEqual(harness.directs().last?.args, ["ids": .array([.string(note)])])
        harness.answerTitles([note: "Plans"])
        let navigation = harness.navigation(.notes)
        XCTAssertEqual(screens.root.tabs.selected, .notes)
        XCTAssertEqual(screens.lastStackAnimated, true, "in front, the stack moves as a push does")
        harness.settle(until: { navigation.topViewController is EditorScreen }, timeout: 5)
        let editor = try XCTUnwrap(navigation.topViewController as? EditorScreen)
        XCTAssertEqual(editor.noteId, note)
        XCTAssertEqual(editor.cover.title, "Plans")
        XCTAssertEqual(navigation.viewControllers.count, 2)
        XCTAssertTrue(harness.requests().contains { $0.op == .tabsShow && $0.args == ["tab": .string("notes")] })
    }

    func testARouteWhileTheAppIsNotInFrontSetsTheStackWithoutMotion() throws {
        screens.inFront = { false }
        harness.deliver(noteRoute)
        harness.answerTitles([note: "Plans"])
        let navigation = harness.navigation(.notes)
        XCTAssertTrue(navigation.topViewController is EditorScreen, "set in the same turn")
        XCTAssertEqual(screens.lastStackAnimated, false)
    }

    func testANoteThatIsGoneOpensTheTabAtItsRootAndNoEditor() {
        harness.deliver(noteRoute)
        harness.answerTitles([:])
        XCTAssertEqual(screens.root.tabs.selected, .notes)
        XCTAssertEqual(harness.navigation(.notes).viewControllers.count, 1)
        XCTAssertTrue(harness.rust.lines.contains("I_SCREENS_ROUTE_NOTE_GONE"))
    }

    func testTheTrashLinkOpensTheTrashInTheLibrary() {
        harness.deliver(#"{"v":1,"notice":"route","route":"stack","tab":"library","stack":[{"kind":"trash"}]}"#)
        XCTAssertFalse(harness.directs().contains { $0.op == .listsTitles }, "no note, nothing to read first")
        XCTAssertEqual(screens.root.tabs.selected, .library)
        XCTAssertTrue(harness.navigation(.library).topViewController is TrashScreen)
    }

    func testALicenceLinkFillsTheKeyInAndSubmitsNothing() throws {
        harness.deliver(#"{"v":1,"notice":"route","route":"licence","prefill":"devot1.abc.def"}"#)
        harness.settle()
        XCTAssertEqual(screens.root.tabs.selected, .settings)
        XCTAssertEqual(harness.navigation(.settings).topViewController?.restorationIdentifier, "licence")
        XCTAssertFalse(harness.directs().contains { $0.op == .licenceSet }, "only the owner's Add submits a key")
    }

    func testTodayAsksThePageForItsNoteThenShowsIt() throws {
        harness.deliver(#"{"v":1,"notice":"route","route":"today"}"#)
        XCTAssertEqual(harness.requests().last?.op, .noteToday)
        harness.answer(.noteToday, .ok(.object(["id": .string(note)])))
        harness.answerTitles([note: "2026-11-07"])
        let navigation = harness.navigation(.notes)
        harness.settle(until: { navigation.topViewController is EditorScreen }, timeout: 5)
        XCTAssertEqual((navigation.topViewController as? EditorScreen)?.noteId, note)
    }

    func testTodayRefusedWhileLockedGoesToTheGateAndShowsNothing() {
        harness.deliver(#"{"v":1,"notice":"route","route":"today"}"#)
        harness.answer(.noteToday, .failed(ProGate.required))
        XCTAssertTrue(harness.rust.lines.contains("W_PHONE_WRITE_LOCKED op=note.today code=E_LICENCE_REQUIRED"))
        XCTAssertFalse(harness.directs().contains { $0.op == .listsTitles })
        XCTAssertEqual(harness.navigation(.notes).viewControllers.count, 1)
    }

    func testAModeLinkAsksTheEditorOnlyWhileANoteIsOnTop() throws {
        let mode = #"{"v":1,"notice":"route","route":"mode","mode":"preview"}"#
        harness.deliver(mode)
        XCTAssertFalse(harness.requests().contains { $0.op == .editorSetMode })
        screens.inFront = { false }
        harness.deliver(noteRoute)
        harness.answerTitles([note: "Plans"])
        harness.settle()
        harness.deliver(mode)
        XCTAssertEqual(harness.requests().last?.op, .editorSetMode)
        XCTAssertEqual(harness.requests().last?.args, ["mode": .string("preview")])
    }

    func testARouteThatDoesNotReadIsLoggedAndChangesNothing() {
        harness.deliver(#"{"v":1,"notice":"route","route":"stack","tab":"settings","stack":[]}"#)
        harness.deliver(#"{"v":1,"notice":"route","route":"stack","tab":"notes","stack":[{"kind":"editor"}]}"#)
        XCTAssertEqual(harness.rust.lines.filter { $0 == "W_SCREENS_NOTICE_INVALID notice=route" }.count, 2)
        XCTAssertEqual(screens.root.tabs.selected, .library)
    }
}
