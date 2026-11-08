import UIKit
import XCTest

@testable import DevotScreens

/// The Search tab's screen around its model (design/phone.md, Search).
@MainActor
final class SearchScreenTests: XCTestCase {
    private var bridge: FakeBridge!
    private var context: ListContext!
    private var defaults: UserDefaults!
    private let suite = "devot.tests.searchScreen"

    override func setUp() async throws {
        bridge = FakeBridge()
        context = ListContext()
        context.bridge = bridge
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    private func screen() -> SearchScreen {
        let screen = SearchScreen(context: context, recents: RecentSearches(defaults: defaults))
        screen.model.after = { _, run in
            run()
            return {}
        }
        screen.loadViewIfNeeded()
        return screen
    }

    private func found(_ rows: [NoteRow]) -> Outcome {
        let rows = rows.map { row -> JSONValue in
            .object([
                "id": .string(row.id), "title": .string(row.title), "createdAt": .number(row.createdAt),
                "updatedAt": .number(row.updatedAt), "bookId": .null, "status": .string(row.status),
                "pinned": .bool(row.pinned), "tagIds": .array([]), "bodyVersion": .number(0),
                "excerpt": .string("found here"),
            ])
        }
        return .ok(.object(["rows": .array(rows), "capped": .bool(false)]))
    }

    private func type(_ screen: SearchScreen, _ text: String) {
        screen.search.searchBar.text = text
        screen.updateSearchResults(for: screen.search)
    }

    func testTheSystemSearchFieldWithTheAllAndTitlesScopesUnderALargeTitle() throws {
        let screen = screen()
        let search = try XCTUnwrap(screen.navigationItem.searchController)
        XCTAssertTrue(search === screen.search)
        XCTAssertFalse(search.obscuresBackgroundDuringPresentation)
        XCTAssertEqual(search.searchBar.placeholder, L10n.phoneSearchPlaceholder())
        XCTAssertEqual(search.searchBar.scopeButtonTitles, [L10n.phoneSearchScopeAll(), L10n.phoneSearchScopeTitles()])
        XCTAssertEqual(screen.navigationItem.title, L10n.phoneTabSearch())
        XCTAssertEqual(screen.navigationItem.largeTitleDisplayMode, .always)
        XCTAssertEqual(screen.listTab, .search)
    }

    func testTheTitlesScopeSearchesTheQueryUnderIt() {
        let screen = screen()
        type(screen, "plan")
        screen.searchBar(screen.search.searchBar, selectedScopeButtonIndexDidChange: 1)
        let scopes = bridge.sent.filter { $0.op == Op.search.rawValue }.map { $0.args["scope"]?.string }
        XCTAssertEqual(scopes, ["all", "titles"])
    }

    func testAResultOpensItsEditorAndTheQueryIsRemembered() throws {
        let screen = screen()
        var opened: [(String, String)] = []
        context.open = { opened.append(($0, $1)) }
        type(screen, "budget")
        let row = noteRow(1, updated: 1, title: "Budget")
        bridge.answer(Op.search.rawValue, found([row]))
        XCTAssertEqual(screen.collection.numberOfSections, 1)
        XCTAssertEqual(screen.collection.numberOfItems(inSection: 0), 1)
        screen.collectionView(screen.collection, didHighlightItemAt: IndexPath(item: 0, section: 0))
        XCTAssertEqual(bridge.sent.last?.op, Op.editorPrepare.rawValue)
        XCTAssertEqual(bridge.sent.last?.args["noteId"]?.string, row.id)
        screen.collectionView(screen.collection, didSelectItemAt: IndexPath(item: 0, section: 0))
        XCTAssertEqual(opened.map(\.0), [row.id])
        XCTAssertEqual(opened.map(\.1), ["Budget"])
        XCTAssertEqual(screen.recents.queries, ["budget"])
    }

    func testNothingFoundSaysSoWithTheQuery() throws {
        let screen = screen()
        type(screen, "zzz")
        bridge.answer(Op.search.rawValue, found([]))
        let empty = try XCTUnwrap(screen.contentUnavailableConfiguration as? UIContentUnavailableConfiguration)
        XCTAssertEqual(empty.text, L10n.phoneSearchNone(query: "zzz"))
        XCTAssertEqual(empty.secondaryText, L10n.phoneSearchHint())
        type(screen, "")
        XCTAssertNil(screen.contentUnavailableConfiguration)
    }

    func testBeforeAQueryRowsFillTheFieldWithAClauseAndSearch() throws {
        let screen = screen()
        bridge.answer(DirectOp.listsLibrary.rawValue, libraryAnswer())
        XCTAssertEqual(screen.query(.book("b1")), "in:Work ")
        XCTAssertEqual(screen.query(.book("b2")), "in:\"Weekly notes\" ")
        XCTAssertEqual(screen.query(.tag("t1")), "#home ")
        XCTAssertEqual(screen.query(.status(.onHold)), "is:on_hold ")
        let sections = (0..<screen.collection.numberOfSections).map { screen.collection.numberOfItems(inSection: $0) }
        XCTAssertEqual(sections, [2, 3, 1])
        screen.collectionView(screen.collection, didSelectItemAt: IndexPath(item: 0, section: 0))
        XCTAssertEqual(screen.search.searchBar.text, "in:Work ")
        XCTAssertEqual(bridge.sent.last?.args["query"]?.string, "in:Work")
    }

    func testTheRecentSearchesComeFirst() {
        RecentSearches(defaults: defaults).remember("milk")
        let screen = screen()
        XCTAssertEqual(screen.collection.numberOfItems(inSection: 0), 1)
        XCTAssertEqual(screen.query(.recent("milk")), "milk")
    }

    func testASavedSearchRunsAtOnce() {
        let screen = screen()
        screen.show(query: "tag:work")
        XCTAssertEqual(screen.search.searchBar.text, "tag:work")
        XCTAssertEqual(bridge.sent.last?.args["query"]?.string, "tag:work")
    }

    func testASavedSearchRunsUnderAllAfterTitlesWasChosen() {
        let screen = screen()
        type(screen, "plan")
        screen.search.searchBar.selectedScopeButtonIndex = 1
        screen.searchBar(screen.search.searchBar, selectedScopeButtonIndexDidChange: 1)
        screen.show(query: "tag:work")
        XCTAssertEqual(bridge.sent.last?.args["query"]?.string, "tag:work")
        XCTAssertEqual(bridge.sent.last?.args["scope"]?.string, "all")
        XCTAssertEqual(screen.search.searchBar.selectedScopeButtonIndex, 0)
        XCTAssertEqual(screen.model.scope, .all)
    }

    func testTheFoundCountSaysHowManyInWordsToo() {
        let one = SearchScreen.foundCount(count: 1, capped: false)
        XCTAssertEqual(one.text, 1.formatted())
        XCTAssertEqual(one.label, L10n.phoneSearchFoundOne(count: 1.formatted()))
        let many = SearchScreen.foundCount(count: 1200, capped: false)
        XCTAssertEqual(many.text, 1200.formatted())
        XCTAssertEqual(many.label, L10n.phoneSearchFoundOther(count: 1200.formatted()))
        let capped = SearchScreen.foundCount(count: 200, capped: true)
        XCTAssertEqual(capped.text, L10n.phoneSearchCountCapped(count: 200.formatted()))
        XCTAssertEqual(capped.label, L10n.phoneSearchFoundCapped(count: 200.formatted()))
    }

    func testRowsBeforeAQuerySayTheySearch() throws {
        RecentSearches(defaults: defaults).remember("milk")
        let screen = screen()
        screen.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        screen.view.layoutIfNeeded()
        let cell = try XCTUnwrap(screen.collection.cellForItem(at: IndexPath(item: 0, section: 0)))
        XCTAssertEqual(cell.accessibilityHint, L10n.phoneSearchSuggestionHint())
        XCTAssertTrue(cell.accessibilityTraits.contains(.button))
    }

    private func libraryAnswer() -> Outcome {
        let book = { (id: String, name: String) -> JSONValue in
            .object([
                "id": .string(id), "name": .string(name), "parentId": .null, "icon": .null, "iconColor": .null,
                "count": .number(1),
            ])
        }
        return .ok(
            .object([
                "counts": .object([
                    "all": .number(0), "pinned": .number(0), "active": .number(0), "onHold": .number(0),
                    "completed": .number(0), "templates": .number(0), "trash": .number(0),
                ]),
                "books": .array([book("b1", "Work"), book("b2", "Weekly notes")]),
                "tags": .array([.object(["id": .string("t1"), "name": .string("home"), "color": .null, "count": .number(1)])]),
                "savedSearches": .array([]),
            ]))
    }
}

final class SearchQueryTests: XCTestCase {
    func testSpellsANameAsTheCoreReadsItElseUsesTheId() {
        XCTAssertEqual(SearchQuery.book(id: "b", name: "Work"), "in:Work")
        XCTAssertEqual(SearchQuery.book(id: "b", name: "Weekly notes"), "in:\"Weekly notes\"")
        XCTAssertEqual(SearchQuery.book(id: "b", name: "Say \"hi\" now"), "bookId:b")
        XCTAssertEqual(SearchQuery.book(id: "b", name: "'quoted'"), "bookId:b")
        XCTAssertEqual(SearchQuery.tag(id: "t", name: "home"), "#home")
        XCTAssertEqual(SearchQuery.tag(id: "t", name: "two words"), "#\"two words\"")
        XCTAssertEqual(SearchQuery.tag(id: "t", name: ""), "tagId:t")
    }
}
