import XCTest

@testable import DevotScreens

func noteRow(
    _ n: Int, updated: Double, status: String = "none", pinned: Bool = false, title: String? = nil, version: Int = 0
) -> NoteRow {
    NoteRow(
        id: String(format: "01970000-0000-7000-8000-%012d", n), title: title ?? "Note \(n)", createdAt: 1,
        updatedAt: updated, bookId: nil, status: status, pinned: pinned, tagIds: [], bodyVersion: version)
}

func page(_ rows: [NoteRow], total: Int? = nil) -> Outcome {
    let rows = rows.map { row -> JSONValue in
        .object([
            "id": .string(row.id), "title": .string(row.title), "createdAt": .number(row.createdAt),
            "updatedAt": .number(row.updatedAt), "bookId": row.bookId.map(JSONValue.string) ?? .null,
            "status": .string(row.status), "pinned": .bool(row.pinned), "tagIds": .array([]),
            "bodyVersion": .number(Double(row.bodyVersion)),
        ])
    }
    return .ok(.object(["rows": .array(rows), "total": .number(Double(total ?? rows.count))]))
}

/// The list's feed: Rust's rows in, the list's sections and what to redraw out
/// (docs/specs/iphone-screens.md, List feed).
@MainActor
final class NoteListDataSourceTests: XCTestCase {
    private var bridge: FakeBridge!
    private var updates: [NoteListDataSource.Update] = []
    private var reduced = false

    private let a = noteRow(1, updated: 30)
    private let b = noteRow(2, updated: 20)
    private let c = noteRow(3, updated: 10)

    override func setUp() async throws {
        bridge = FakeBridge()
        updates = []
        reduced = false
    }

    private func source(_ view: ListView = .all, rows: [NoteRow]? = nil) -> NoteListDataSource {
        let source = NoteListDataSource(view: view, bridge: bridge)
        source.reduceMotion = { [unowned self] in reduced }
        source.onUpdate = { [unowned self] in updates.append($0) }
        source.load()
        bridge.answer(DirectOp.listsNotes.rawValue, page(rows ?? [a, b, c]))
        return source
    }

    /// A list scrolled far enough to have read a second page.
    private func pagedIn(_ rows: [NoteRow]) -> NoteListDataSource {
        let source = NoteListDataSource(view: .all, bridge: bridge)
        source.onUpdate = { [unowned self] in updates.append($0) }
        source.load()
        bridge.answer(DirectOp.listsNotes.rawValue, page(Array(rows.prefix(NoteListDataSource.pageRows)), total: rows.count))
        source.loadMore()
        bridge.answer(DirectOp.listsNotes.rawValue, page(Array(rows.dropFirst(NoteListDataSource.pageRows)), total: rows.count))
        return source
    }

    private var lastAsk: [String: JSONValue]? { bridge.sent.last { $0.op == DirectOp.listsNotes.rawValue }?.args }

    func testTheRowsDecodeFromTheSharedFixture() throws {
        let url = try XCTUnwrap(
            Bundle(for: NoteListDataSourceTests.self).url(forResource: "screens", withExtension: nil)
        ).appendingPathComponent("rows.json")
        let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        let notes = try XCTUnwrap(fixture["notes"]?.decoded(NotePage.self))
        XCTAssertEqual(notes.rows.map(\.status), ["active", "none", "completed"])
        XCTAssertEqual(notes.rows.first?.tagIds.count, 1)
        let library = try XCTUnwrap(fixture["library"]?.decoded(LibraryContents.self))
        XCTAssertEqual(library.counts.onHold, 0)
        XCTAssertEqual(library.depths, [library.books[0].id: 0, library.books[1].id: 1])
        XCTAssertEqual(try XCTUnwrap(fixture["trash"]?.decoded([TrashedRow].self)).count, 1)
    }

    func testTheFirstPaintIsOneUnanimatedPageInPinnedRecentAndCompletedSections() throws {
        let pinned = noteRow(4, updated: 5, pinned: true)
        let done = noteRow(5, updated: 40, status: "completed")
        let source = NoteListDataSource(view: .all, bridge: bridge)
        source.onUpdate = { [unowned self] in updates.append($0) }
        source.load()
        XCTAssertEqual(lastAsk?["view"], ListView.all.json)
        XCTAssertEqual(lastAsk?["offset"], .number(0))
        XCTAssertEqual(lastAsk?["limit"], .number(Double(NoteListDataSource.pageRows)))
        bridge.answer(DirectOp.listsNotes.rawValue, page([done, a, pinned]))
        let update = try XCTUnwrap(updates.last)
        XCTAssertFalse(update.animated)
        XCTAssertEqual(update.layout.sections, [.pinned, .recent, .completed])
        XCTAssertEqual(update.layout.ids[.pinned], [pinned.id])
        XCTAssertEqual(update.layout.ids[.recent], [a.id])
        XCTAssertEqual(update.layout.ids[.completed], [done.id])
    }

    func testTemplatesAreOneSectionWhateverTheirStatus() {
        _ = source(.templates, rows: [a, noteRow(5, updated: 1, status: "completed", pinned: true)])
        XCTAssertEqual(updates.last?.layout.sections, [.recent])
        XCTAssertEqual(updates.last?.layout.ids[.recent]?.count, 2)
    }

    func testAChangedRowReconfiguresInPlace() throws {
        let source = source()
        source.changed(rev: 1, ids: [b.id], all: false)
        XCTAssertEqual(lastAsk?["limit"], .number(Double(NoteListDataSource.pageRows)))
        bridge.answer(DirectOp.listsNotes.rawValue, page([a, noteRow(2, updated: 20, title: "Renamed", version: 1), c]))
        let update = try XCTUnwrap(updates.last)
        XCTAssertEqual(update.layout.ids[.recent], [a.id, b.id, c.id])
        XCTAssertEqual(update.reconfigured, [b.id])
        XCTAssertTrue(update.animated)
        XCTAssertFalse(update.reloaded)
        XCTAssertEqual(source.row(b.id)?.title, "Renamed")
    }

    func testAMovedRowMovesAndReconfigures() throws {
        let source = source()
        source.changed(rev: 1, ids: [c.id], all: false)
        bridge.answer(DirectOp.listsNotes.rawValue, page([noteRow(3, updated: 50, version: 1), a, b]))
        let update = try XCTUnwrap(updates.last)
        XCTAssertEqual(update.layout.ids[.recent], [c.id, a.id, b.id])
        XCTAssertEqual(update.reconfigured, [c.id])
        XCTAssertTrue(update.animated)
    }

    func testACompletedRowMovesToTheCompletedSection() throws {
        let source = source()
        source.changed(rev: 1, ids: [a.id], all: false)
        bridge.answer(DirectOp.listsNotes.rawValue, page([noteRow(1, updated: 31, status: "completed"), b, c]))
        let update = try XCTUnwrap(updates.last)
        XCTAssertEqual(update.layout.sections, [.recent, .completed])
        XCTAssertEqual(update.layout.ids[.completed], [a.id])
    }

    func testASkippedRevReadsTheListAgain() throws {
        let source = source()
        source.changed(rev: 4, ids: [a.id], all: false)
        bridge.answer(DirectOp.listsNotes.rawValue, page([a, b, c]))
        XCTAssertEqual(updates.last?.reloaded, false)
        source.changed(rev: 6, ids: [b.id], all: false)
        XCTAssertEqual(lastAsk?["offset"], .number(0))
        XCTAssertEqual(lastAsk?["limit"], .number(Double(NoteListDataSource.pageRows)))
        bridge.answer(DirectOp.listsNotes.rawValue, page([b, c]))
        let update = try XCTUnwrap(updates.last)
        XCTAssertTrue(update.reloaded)
        XCTAssertEqual(update.layout.ids[.recent], [b.id, c.id])
    }

    func testAMissedChangeReadsAgainEveryRowAlreadyPagedIn() throws {
        let many = (1...250).map { noteRow($0, updated: Double(1000 - $0)) }
        let source = pagedIn(many)
        XCTAssertEqual(source.count, 250)
        source.changed(rev: 3, ids: [], all: true)
        XCTAssertEqual(lastAsk?["offset"], .number(0))
        XCTAssertEqual(lastAsk?["limit"], .number(250))
        bridge.answer(DirectOp.listsNotes.rawValue, page(many, total: 250))
        XCTAssertEqual(source.count, 250)
        XCTAssertEqual(updates.last?.reloaded, true)
    }

    func testAStatusFilterStartsAgainFromTheFirstPage() {
        let many = (1...250).map { noteRow($0, updated: Double(1000 - $0)) }
        let source = pagedIn(many)
        source.filter(.active)
        XCTAssertEqual(lastAsk?["limit"], .number(Double(NoteListDataSource.pageRows)))
    }

    func testAChangeTooLargeToNameReloadsAndAnOldRevIsIgnored() {
        let source = source()
        source.changed(rev: 2, ids: [], all: true)
        bridge.answer(DirectOp.listsNotes.rawValue, page([a]))
        XCTAssertEqual(updates.last?.reloaded, true)
        let asked = bridge.sent.count
        source.changed(rev: 2, ids: [a.id], all: false)
        source.changed(rev: 1, ids: [a.id], all: false)
        XCTAssertEqual(bridge.sent.count, asked)
    }

    func testChangesDuringAReadAreReadOnceAfterIt() {
        let source = source()
        source.changed(rev: 1, ids: [a.id], all: false)
        source.changed(rev: 2, ids: [b.id], all: false)
        source.changed(rev: 3, ids: [c.id], all: false)
        XCTAssertEqual(bridge.ops, [DirectOp.listsNotes.rawValue])
        bridge.answer(DirectOp.listsNotes.rawValue, page([a, b, c]))
        XCTAssertEqual(bridge.ops, [DirectOp.listsNotes.rawValue])
        bridge.answer(DirectOp.listsNotes.rawValue, page([a, b, c]))
        XCTAssertEqual(bridge.ops, [])
        XCTAssertEqual(Set(updates.last?.reconfigured ?? []), [b.id, c.id])
    }

    func testReduceMotionAppliesWithoutAnimation() {
        reduced = true
        let source = source()
        source.changed(rev: 1, ids: [a.id], all: false)
        bridge.answer(DirectOp.listsNotes.rawValue, page([b, a, c]))
        XCTAssertEqual(updates.last?.animated, false)
    }

    func testAnUntouchedNewRowIsRemovedWithoutAnimationOrARead() throws {
        let source = source()
        let asked = bridge.sent.count
        source.removeUntouched(b.id)
        XCTAssertEqual(bridge.sent.count, asked)
        let update = try XCTUnwrap(updates.last)
        XCTAssertFalse(update.animated)
        XCTAssertEqual(update.layout.ids[.recent], [a.id, c.id])
        XCTAssertNil(source.row(b.id))
    }

    func testANewNoteIsAppliedQuietlyAndSelected() throws {
        let source = source()
        let made = noteRow(9, updated: 99)
        source.quietly(selecting: made.id)
        bridge.answer(DirectOp.listsNotes.rawValue, page([made, a, b, c]))
        let update = try XCTUnwrap(updates.last)
        XCTAssertFalse(update.animated)
        XCTAssertEqual(update.selected, made.id)
        XCTAssertEqual(update.layout.ids[.recent]?.first, made.id)
    }

    func testMoreRowsArePagedAfterTheLoadedOnes() {
        let source = source(rows: [a, b])
        bridge.sent.removeAll()
        source.loadMore()
        XCTAssertEqual(bridge.ops, [])
        let more = NoteListDataSource(view: .all, bridge: bridge)
        more.load()
        bridge.answer(DirectOp.listsNotes.rawValue, page([a, b], total: 3))
        more.loadMore()
        XCTAssertEqual(lastAsk?["offset"], .number(2))
        more.onUpdate = { [unowned self] in updates.append($0) }
        bridge.answer(DirectOp.listsNotes.rawValue, page([c], total: 3))
        XCTAssertEqual(updates.last?.layout.ids[.recent], [a.id, b.id, c.id])
        XCTAssertFalse(more.hasMore)
    }

    func testAStatusFilterReadsAgainAndAFailedReadIsLoggedByCode() {
        let source = source()
        source.filter(.completed)
        XCTAssertEqual(lastAsk?["status"], .string("completed"))
        bridge.answer(DirectOp.listsNotes.rawValue, .failed("E_STORAGE_BUSY"))
        XCTAssertEqual(bridge.lines, ["W_PHONE_LIST_READ_FAILED code=E_STORAGE_BUSY"])
    }
}
