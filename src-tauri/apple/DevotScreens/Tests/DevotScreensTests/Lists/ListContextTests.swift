import XCTest

@testable import DevotScreens

@MainActor
private final class Offers: UndoOffering {
    var toasts: [UndoToast] = []
    func offer(_ toast: UndoToast) { toasts.append(toast) }
}

/// The lists' writes once the gate lets them, and their reads again when the page reports a change.
@MainActor
final class ListContextTests: XCTestCase {
    private var bridge: FakeBridge!
    private var context: ListContext!
    private var shown: [LockSurface] = []
    private var opened: [String] = []
    private var left = 0
    private let offers = Offers()

    private let id = "01970000-0000-7000-8000-000000000001"
    private let book = "01970000-0000-7000-8000-0000000000b1"

    override func setUp() async throws {
        bridge = FakeBridge()
        shown = []
        opened = []
        left = 0
        context = ListContext()
        context.bridge = bridge
        context.gate.present = { [unowned self] in shown.append($0) }
        context.open = { [unowned self] id, _ in opened.append(id) }
        context.undoToasts = offers
    }

    func testABatchSendsOneChangeForEveryNamedNote() throws {
        XCTAssertTrue(context.perform(.batch(ids: [id], change: .book(nil))))
        let sent = try XCTUnwrap(bridge.sent.first)
        XCTAssertEqual(sent.op, Op.notesBatch.rawValue)
        XCTAssertEqual(sent.args["ids"], .array([.string(id)]))
        XCTAssertEqual(sent.args["change"], .object(["kind": .string("book"), "bookId": .null]))
        XCTAssertEqual(NoteChange.status(.onHold).json["status"], .string("on_hold"))
        XCTAssertEqual(NoteChange.putTag(book).json["tagId"], .string(book))
        XCTAssertFalse(context.perform(.newNote(bookId: nil)))
    }

    func testARefusedWriteShowsTheGatesSurfaceAndAnyOtherIsLoggedByCode() {
        context.perform(.batch(ids: [id], change: .trash))
        bridge.answer(Op.notesBatch.rawValue, .failed(ProGate.required))
        XCTAssertEqual(shown, [.pro(.key)])
        context.gate.dismissed()
        context.perform(.batch(ids: [id], change: .trash))
        bridge.answer(
            Op.notesBatch.rawValue,
            .ok(.object(["changed": .array([]), "failed": .array([.object(["id": .string(id), "code": .string(ProGate.required)])])])))
        XCTAssertEqual(shown.count, 2)
        context.gate.dismissed()
        context.perform(.emptyTrash)
        bridge.answer(Op.trashEmpty.rawValue, .failed("E_STORAGE_BUSY"))
        XCTAssertEqual(bridge.lines, ["W_PHONE_LIST_WRITE_FAILED op=trash.empty code=E_STORAGE_BUSY"])
        XCTAssertEqual(shown.count, 2)
    }

    func testANewNotebookIsMadeByThePage() throws {
        XCTAssertTrue(context.perform(.newNotebook))
        let sent = try XCTUnwrap(bridge.sent.first)
        XCTAssertEqual(sent.op, Op.bookCreate.rawValue)
        XCTAssertEqual(sent.args, [:])
        bridge.answer(Op.bookCreate.rawValue, .failed("E_STORAGE_BUSY"))
        XCTAssertEqual(bridge.lines, ["W_PHONE_LIST_WRITE_FAILED op=book.create code=E_STORAGE_BUSY"])
    }

    func testATemplateMadeOrUsedOpensItsNote() {
        context.perform(.newTemplate)
        bridge.answer(Op.templateCreate.rawValue, .ok(.object(["id": .string(id)])))
        context.perform(.fromTemplate(templateId: id, bookId: book))
        XCTAssertEqual(bridge.sent.first?.args, ["templateId": .string(id), "bookId": .string(book)])
        bridge.answer(Op.templateApply.rawValue, .ok(.object(["id": .string(book)])))
        XCTAssertEqual(opened, [id, book])
    }

    func testAChangeReadsTheListsAndTheLibraryThatAScreenAskedFor() {
        let source = context.source(.all)
        let unseen = context.source(.pinned)
        context.notesChanged(rev: 1, ids: [id], all: false)
        XCTAssertEqual(bridge.ops, [])
        source.load()
        bridge.answer(DirectOp.listsNotes.rawValue, page([]))
        context.readLibrary()
        bridge.answer(DirectOp.listsLibrary.rawValue, .failed("E_SCREENS_UNAVAILABLE"))
        context.notesChanged(rev: 2, ids: [id], all: false)
        XCTAssertEqual(Set(bridge.ops), [DirectOp.listsNotes.rawValue, DirectOp.listsLibrary.rawValue])
        context.libraryChanged()
        XCTAssertEqual(bridge.ops.filter { $0 == DirectOp.listsLibrary.rawValue }.count, 1)
        XCTAssertFalse(unseen.wanted)
    }

    private func trashed(_ ids: [String], failed: [JSONValue] = []) {
        context.perform(.batch(ids: ids, change: .trash))
        bridge.answer(
            Op.notesBatch.rawValue,
            .ok(.object(["changed": .array(ids.map(JSONValue.string)), "failed": .array(failed)])))
    }

    func testOneNoteTrashedIsOfferedBackAndUndoRestoresIt() throws {
        trashed([id])
        XCTAssertEqual(offers.toasts.map(\.kind), [.trashed])
        XCTAssertEqual(bridge.ops, [])
        offers.toasts[0].onUndo()
        let sent = try XCTUnwrap(bridge.sent.first)
        XCTAssertEqual(sent.op, Op.notesBatch.rawValue)
        XCTAssertEqual(sent.args["ids"], .array([.string(id)]))
        XCTAssertEqual(sent.args["change"], .object(["kind": .string("restore")]))
        bridge.answer(Op.notesBatch.rawValue, .ok(.object(["changed": .array([.string(id)]), "failed": .array([])])))
        XCTAssertEqual(offers.toasts.count, 1, "taking it back is not offered back")
    }

    func testSeveralNotesATrashThatFailedAndOtherChangesOfferNothing() {
        trashed([id, book])
        trashed([id], failed: [.object(["id": .string(id), "code": .string("E_STORAGE_BUSY")])])
        context.perform(.batch(ids: [id], change: .pinned(true)))
        bridge.answer(Op.notesBatch.rawValue, .ok(.object(["changed": .array([.string(id)]), "failed": .array([])])))
        context.perform(.batch(ids: [id], change: .restore))
        bridge.answer(Op.notesBatch.rawValue, .ok(.object(["changed": .array([.string(id)]), "failed": .array([])])))
        XCTAssertEqual(offers.toasts.count, 0)
    }

    func testMoveToTrashFromTheNoteLeavesItOnlyOnceTheNoteIsInTheTrash() {
        context.gate.perform = { [unowned self] in context.perform($0) }
        let ok = JSONValue.object(["changed": .array([.string(id)]), "failed": .array([])])
        context.trash(id) { [unowned self] in left += 1 }
        XCTAssertEqual(left, 0, "not before Rust has answered")
        bridge.answer(Op.notesBatch.rawValue, .ok(ok))
        XCTAssertEqual(left, 1)
        XCTAssertEqual(offers.toasts.map(\.kind), [.trashed])

        context.trash(id) { [unowned self] in left += 1 }
        bridge.answer(Op.notesBatch.rawValue, .failed(ProGate.required))
        context.gate.dismissed()
        context.trash(id) { [unowned self] in left += 1 }
        bridge.answer(
            Op.notesBatch.rawValue,
            .ok(.object(["changed": .array([]), "failed": .array([.object(["id": .string(id), "code": .string("E_STORAGE_BUSY")])])])))
        context.perform(.batch(ids: [id], change: .trash))
        bridge.answer(Op.notesBatch.rawValue, .ok(ok))
        XCTAssertEqual(left, 1, "a refused or failed trash leaves the note, and is forgotten")
    }

    func testALockedTrashShowsTheGateAndOffersNothing() {
        context.perform(.batch(ids: [id], change: .trash))
        bridge.answer(Op.notesBatch.rawValue, .failed(ProGate.required))
        XCTAssertEqual(shown, [.pro(.key)])
        XCTAssertEqual(offers.toasts.count, 0)
    }

    private let undoable = JSONValue.object([
        "status": .string("active"), "updatedAt": .number(1_800_000_000_000),
        "statusHlc": .string("0001800000000000-0000-lists1"), "bodyVersion": .number(3),
    ])

    func testACompletionIsOfferedBackWithTheUndoThePageHandedOver() throws {
        context.perform(.complete(id: id))
        let sent = try XCTUnwrap(bridge.sent.first)
        XCTAssertEqual(sent.op, Op.noteComplete.rawValue)
        XCTAssertEqual(sent.args, ["noteId": .string(id)])
        bridge.answer(Op.noteComplete.rawValue, .ok(.object(["undo": undoable])))
        XCTAssertEqual(offers.toasts.map(\.kind), [.completed])
        offers.toasts[0].onUndo()
        let undo = try XCTUnwrap(bridge.sent.first)
        XCTAssertEqual(undo.op, Op.noteUndoStatus.rawValue)
        XCTAssertEqual(undo.args, ["noteId": .string(id), "undo": undoable])
    }

    func testACompletionRefusedOrAnsweredWithoutAnUndoOffersNothing() {
        context.perform(.complete(id: id))
        bridge.answer(Op.noteComplete.rawValue, .failed(ProGate.unreadable))
        XCTAssertEqual(shown, [.pro(.unreadable)])
        context.gate.dismissed()
        context.perform(.complete(id: id))
        bridge.answer(Op.noteComplete.rawValue, .ok(.object([:])))
        XCTAssertEqual(offers.toasts.count, 0)
    }

    func testAWriteTheGateLetsThroughFeelsOnceAndAHeldOrUnfeltOneFeelsNothing() {
        let recorder = HapticRecorder()
        var performed: [WriteIntent] = []
        context.haptics = Haptics(make: recorder.make)
        context.gate.perform = { performed.append($0) }
        context.ask(.batch(ids: [id], change: .pinned(true)))
        XCTAssertEqual(recorder.log, ["light.prepare", "light.occurred"])
        recorder.clear()
        context.ask(.batch(ids: [id], change: .status(.completed)))
        XCTAssertEqual(recorder.log, ["selection.prepare", "selection.occurred"])
        recorder.clear()
        for intent in [WriteIntent.batch(ids: [id], change: .purge), .emptyTrash, .newTemplate, .newNote(bookId: nil)] {
            context.ask(intent)
        }
        XCTAssertEqual(recorder.log, [])
        XCTAssertEqual(performed.count, 6, "every asked write still goes through the gate")

        context.gate.licence = { Licence(gated: true, state: "none", trial: Licence.Trial(state: "ended", endsAt: 1000, code: nil)) }
        context.ask(.batch(ids: [id], change: .trash))
        XCTAssertEqual(shown.count, 1, "a locked write shows the gate's surface")
        XCTAssertEqual(performed.count, 6)
        XCTAssertEqual(recorder.log, [], "and the gate's own haptic is the screens', not a list's")
    }

    func testAPressedRowAsksThePageToReadItsNoteAheadOfThePush() throws {
        context.prepare(id)
        let sent = try XCTUnwrap(bridge.sent.first)
        XCTAssertEqual(sent.op, Op.editorPrepare.rawValue)
        XCTAssertEqual(sent.args, ["noteId": .string(id)])
        bridge.answer(Op.editorPrepare.rawValue, .failed("E_SCREENS_UNAVAILABLE"))
        XCTAssertEqual(shown, [])
        XCTAssertEqual(bridge.lines, [])
    }

    func testAScreenPreparesTheGeneratorsAMenuMayFireWhenItOpens() {
        let recorder = HapticRecorder()
        context.haptics = Haptics(make: recorder.make)
        context.prepareHaptics()
        XCTAssertEqual(Set(recorder.log), ["light.prepare", "selection.prepare"])
        XCTAssertFalse(recorder.log.contains { $0.hasSuffix("occurred") })
    }
}
