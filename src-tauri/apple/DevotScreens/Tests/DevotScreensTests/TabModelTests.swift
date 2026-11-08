import XCTest

@testable import DevotScreens

final class TabModelTests: XCTestCase {
    func testStartsOnLibraryAsThePageDoes() {
        let model = TabModel()
        XCTAssertEqual(model.selected, .library)
        XCTAssertEqual(TabModel.tabs, [.notes, .library, .activity, .settings])
    }

    func testTellsThePageWhichTabAppearedOnceEach() {
        var model = TabModel()
        XCTAssertEqual(model.appeared(.library), [.show(.library)])
        XCTAssertEqual(model.appeared(.library), [])
        XCTAssertEqual(model.appeared(.notes), [.show(.notes)])
        XCTAssertEqual(model.selected, .notes)
    }

    func testAReselectedTabPopsToItsRoot() {
        var model = TabModel()
        _ = model.appeared(.library)
        XCTAssertEqual(model.reselected(.library), [.popToRoot(.library)])
        XCTAssertEqual(model.reselected(.notes), [])
    }

    func testFollowsATabThePageChoseItself() {
        var model = TabModel()
        _ = model.appeared(.library)
        model.showAnswered()
        XCTAssertEqual(
            model.pageState(tab: .settings, barHidden: false, attention: false), [.select(.settings)])
        XCTAssertEqual(model.appeared(.settings), [])
    }

    func testIgnoresThePageTabWhileAShowIsUnanswered() {
        var model = TabModel()
        _ = model.appeared(.library)
        model.showAnswered()
        _ = model.appeared(.notes)
        XCTAssertEqual(model.pageState(tab: .library, barHidden: false, attention: false), [])
        XCTAssertEqual(model.selected, .notes)
        model.showAnswered()
        XCTAssertEqual(model.pageState(tab: .notes, barHidden: false, attention: false), [])
    }

    func testSearchIsNativeAloneSoThePageIsNeitherToldNorFollowed() {
        var model = TabModel()
        _ = model.appeared(.library)
        model.showAnswered()
        XCTAssertEqual(model.appeared(.search), [])
        XCTAssertEqual(model.selected, .search)
        XCTAssertEqual(model.reselected(.search), [])
        XCTAssertEqual(model.pageState(tab: .library, barHidden: false, attention: true), [.badge(true)])
        XCTAssertEqual(model.selected, .search)
        XCTAssertEqual(model.pageState(tab: .settings, barHidden: false, attention: true), [.select(.settings)])
        XCTAssertEqual(model.appeared(.library), [.show(.library)])
    }

    func testHidesTheBarAndShowsTheBadgeOnlyWhenTheyChange() {
        var model = TabModel()
        XCTAssertEqual(model.pageState(tab: .library, barHidden: true, attention: true), [.hideBar(true), .badge(true)])
        XCTAssertEqual(model.pageState(tab: .library, barHidden: true, attention: true), [])
        XCTAssertEqual(model.pageState(tab: .library, barHidden: false, attention: true), [.hideBar(false)])
    }

    func testReadsTheTabsStateNotice() {
        let fields: [String: JSONValue] = [
            "tab": .string("activity"), "barHidden": .bool(true), "attention": .bool(false),
        ]
        XCTAssertEqual(
            TabModel.PageState(fields), TabModel.PageState(tab: .activity, barHidden: true, attention: false))
        XCTAssertNil(TabModel.PageState(["tab": .string("search"), "barHidden": .bool(true), "attention": .bool(false)]))
        XCTAssertNil(TabModel.PageState(["tab": .string("notes"), "barHidden": .bool(true)]))
    }

    func testTheBadgeIsTheWebShellsMark() {
        XCTAssertEqual(TabModel.badgeValue(true), "!")
        XCTAssertNil(TabModel.badgeValue(false))
    }
}
