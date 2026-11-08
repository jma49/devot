import XCTest

@testable import DevotScreens

/// The Search tab's query, scope and results (docs/specs/iphone-screens.md, Search).
@MainActor
final class SearchModelTests: XCTestCase {
    private var bridge: FakeBridge!
    private var timers: [(delay: TimeInterval, run: () -> Void, cancelled: Bool)] = []
    private var shown = 0

    override func setUp() async throws {
        bridge = FakeBridge()
        timers = []
        shown = 0
    }

    private func model() -> SearchModel {
        let model = SearchModel { [unowned self] in bridge }
        model.after = { [unowned self] delay, run in
            let index = timers.count
            timers.append((delay, run, false))
            return { [unowned self] in timers[index].cancelled = true }
        }
        model.onResults = { [unowned self] in shown += 1 }
        return model
    }

    private func fire() {
        let live = timers.indices.filter { !timers[$0].cancelled }
        for index in live {
            timers[index].cancelled = true
            timers[index].run()
        }
    }

    private func found(_ rows: [NoteRow], excerpts: [String: String] = [:], capped: Bool = false) -> Outcome {
        let rows = rows.map { row -> JSONValue in
            var fields: [String: JSONValue] = [
                "id": .string(row.id), "title": .string(row.title), "createdAt": .number(row.createdAt),
                "updatedAt": .number(row.updatedAt), "bookId": row.bookId.map(JSONValue.string) ?? .null,
                "status": .string(row.status), "pinned": .bool(row.pinned), "tagIds": .array([]),
                "bodyVersion": .number(Double(row.bodyVersion)),
            ]
            if let excerpt = excerpts[row.id] { fields["excerpt"] = .string(excerpt) }
            return .object(fields)
        }
        return .ok(.object(["rows": .array(rows), "capped": .bool(capped)]))
    }

    private func asked(_ index: Int = 0) -> (query: String?, scope: String?) {
        (bridge.sent[index].args["query"]?.string, bridge.sent[index].args["scope"]?.string)
    }

    func testTypingSearchesOnceTheTypingPausesFor120Milliseconds() {
        let model = model()
        model.type("b")
        model.type("bu")
        model.type("bud")
        XCTAssertTrue(bridge.sent.isEmpty)
        XCTAssertEqual(timers.map(\.delay), [0.12, 0.12, 0.12])
        XCTAssertEqual(timers.map(\.cancelled), [true, true, false])
        fire()
        XCTAssertEqual(bridge.ops, [Op.search.rawValue])
        XCTAssertEqual(asked().query, "bud")
        XCTAssertEqual(asked().scope, "all")
    }

    func testTheSameQueryWithOtherSpacesIsNotSearchedAgain() {
        let model = model()
        model.type("budget")
        fire()
        model.type("budget ")
        XCTAssertEqual(timers.count, 1)
        XCTAssertEqual(bridge.sent.count, 1)
    }

    func testChoosingAScopeSearchesAtOnceUnderIt() {
        let model = model()
        model.type("plan")
        model.choose(.titles)
        XCTAssertEqual(timers.map(\.cancelled), [true])
        XCTAssertEqual(asked().query, "plan")
        XCTAssertEqual(asked().scope, "titles")
        model.choose(.titles)
        XCTAssertEqual(bridge.sent.count, 1)
        model.choose(.all)
        XCTAssertEqual(asked(1).scope, "all")
    }

    func testAScopeChosenWithNoQuerySearchesNothing() {
        let model = model()
        model.choose(.titles)
        XCTAssertTrue(bridge.sent.isEmpty)
        model.type("plan")
        fire()
        XCTAssertEqual(asked().scope, "titles")
    }

    func testRunningAQuerySearchesAtOnce() {
        let model = model()
        model.run("in:Work ")
        XCTAssertTrue(timers.isEmpty)
        XCTAssertEqual(asked().query, "in:Work")
        XCTAssertEqual(model.query, "in:Work")
    }

    func testResultsReplaceTheListWhenTheyArrive() {
        let model = model()
        model.type("note")
        fire()
        let first = [noteRow(1, updated: 2), noteRow(2, updated: 1)]
        bridge.answer(Op.search.rawValue, found(first, excerpts: [first[1].id: "a note body"]))
        XCTAssertEqual(model.results?.hits.map(\.note.id), first.map(\.id))
        XCTAssertEqual(model.results?.hits.map(\.excerpt), [nil, "a note body"])
        XCTAssertEqual(model.results?.query, "note")
        XCTAssertEqual(model.results?.capped, false)
        XCTAssertEqual(shown, 1)
        model.type("note 3")
        XCTAssertEqual(model.results?.hits.count, 2)
        fire()
        bridge.answer(Op.search.rawValue, found([noteRow(3, updated: 3)], capped: true))
        XCTAssertEqual(model.results?.hits.map(\.note.id), [noteRow(3, updated: 3).id])
        XCTAssertEqual(model.results?.capped, true)
        XCTAssertEqual(shown, 2)
    }

    func testAnAnswerToAnOlderSearchIsDropped() {
        let model = model()
        model.type("a")
        fire()
        model.type("ab")
        fire()
        bridge.answer(Op.search.rawValue, found([noteRow(1, updated: 1)]))
        XCTAssertNil(model.results)
        XCTAssertEqual(shown, 0)
        bridge.answer(Op.search.rawValue, found([noteRow(2, updated: 1)]))
        XCTAssertEqual(model.results?.hits.map(\.note.id), [noteRow(2, updated: 1).id])
    }

    func testClearingTheFieldShowsTheStartAtOnceAndDropsWhatIsOnItsWay() {
        let model = model()
        model.type("a")
        fire()
        bridge.answer(Op.search.rawValue, found([noteRow(1, updated: 1)]))
        model.type("ab")
        fire()
        model.type(" ")
        XCTAssertNil(model.results)
        XCTAssertEqual(model.query, "")
        XCTAssertEqual(shown, 2)
        bridge.answer(Op.search.rawValue, found([noteRow(2, updated: 1)]))
        XCTAssertNil(model.results)
        model.type("abc")
        model.type("")
        fire()
        XCTAssertTrue(bridge.sent.isEmpty)
    }

    func testAFailedSearchKeepsWhatIsShownAndLogsItsCode() {
        let model = model()
        model.type("a")
        fire()
        bridge.answer(Op.search.rawValue, found([noteRow(1, updated: 1)]))
        model.type("ab")
        fire()
        bridge.answer(Op.search.rawValue, .failed("E_SCREENS_QUERY_TOO_LONG"))
        XCTAssertEqual(model.results?.query, "a")
        XCTAssertEqual(bridge.lines, ["W_PHONE_SEARCH_FAILED code=E_SCREENS_QUERY_TOO_LONG"])
    }

    func testANoteChangeSearchesAgainAfterThePause() {
        let model = model()
        model.notesChanged()
        XCTAssertTrue(timers.isEmpty)
        model.type("a")
        fire()
        bridge.answer(Op.search.rawValue, found([noteRow(1, updated: 1)]))
        model.notesChanged()
        model.notesChanged()
        XCTAssertEqual(timers.filter { !$0.cancelled }.count, 1)
        fire()
        XCTAssertEqual(asked().query, "a")
    }
}

/// This iPhone's recent searches: never synced and never logged.
final class RecentSearchesTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "devot.tests.recentSearches"

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    func testKeepsTheSixNewestOnceEachNewestFirst() {
        let recent = RecentSearches(defaults: defaults)
        for query in ["one", "two", "three", "four", "five", "six", "seven"] { recent.remember(query) }
        XCTAssertEqual(recent.queries, ["seven", "six", "five", "four", "three", "two"])
        recent.remember(" four ")
        XCTAssertEqual(recent.queries, ["four", "seven", "six", "five", "three", "two"])
        XCTAssertEqual(RecentSearches(defaults: defaults).queries, recent.queries)
    }

    func testIgnoresAnEmptyQueryAndWhatIsStoredBadly() {
        let recent = RecentSearches(defaults: defaults)
        recent.remember("   ")
        XCTAssertEqual(recent.queries, [])
        defaults.set(["ok", 3, ""], forKey: RecentSearches.key)
        XCTAssertEqual(RecentSearches(defaults: defaults).queries, ["ok"])
        defaults.set("not a list", forKey: RecentSearches.key)
        XCTAssertEqual(RecentSearches(defaults: defaults).queries, [])
    }
}
