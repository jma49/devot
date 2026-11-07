import XCTest

@testable import DevotScreens

/// The page's search over the same index: tests/fixtures/settings-search.json holds what it finds.
@MainActor
final class SettingsSearchTests: XCTestCase {
    private struct Shared: Decodable {
        struct Hit: Decodable, Equatable {
            let pane: String
            let label: String
        }

        struct Case: Decodable {
            let query: String
            let results: [Hit]
        }

        let panes: [String]
        let cases: [Case]
    }

    private func shared() throws -> Shared {
        let url = try XCTUnwrap(Bundle(for: SettingsSearchTests.self).url(forResource: "settings-search", withExtension: "json"))
        return try JSONDecoder().decode(Shared.self, from: Data(contentsOf: url))
    }

    func testFindsWhatThePageFindsForEverySharedQuery() throws {
        let shared = try shared()
        XCTAssertEqual(shared.panes, SettingsSearch.phonePanes)
        XCTAssertFalse(shared.cases.isEmpty)
        for test in shared.cases {
            let found = SettingsSearch().results(for: test.query).map { Shared.Hit(pane: $0.pane, label: $0.label) }
            XCTAssertEqual(found, test.results, "query \(test.query)")
        }
    }

    func testGroupsResultsByPaneInTheOrderThePanesFirstCome() {
        let search = SettingsSearch()
        let sections = search.sections(for: "font")
        XCTAssertEqual(sections.flatMap(\.results), search.results(for: "font"))
        XCTAssertEqual(Set(sections.map(\.pane)).count, sections.count)
        XCTAssertEqual(search.sections(for: "  "), [])
    }

    func testListsNoMoreThanTwelveResults() {
        var search = SettingsSearch()
        search.label = { _ in "x" }
        XCTAssertEqual(search.results(for: "x").count, 12)
    }

    func testEveryPhonePaneHasASymbolAndAPage() {
        for pane in SettingsSearch.phonePanes {
            XCTAssertNotNil(SettingsRootView.symbols[pane].flatMap { UIImage(systemName: $0) }, pane)
            XCTAssertNotNil(SettingsPage(pane: pane), pane)
        }
    }
}
