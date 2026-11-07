import XCTest

@testable import DevotScreens

final class NavigationStateTests: XCTestCase {
    func testEachTabKeepsItsOwnStack() {
        var state = NavigationState()
        state.push(.notebook(id: "work"))
        state.push(.note(id: "a"))
        state.select(.settings)
        XCTAssertNil(state.top)
        state.push(.pane("sync"))
        state.select(.notes)
        XCTAssertEqual(state.top, .note(id: "a"))
        state.pop()
        XCTAssertEqual(state.top, .notebook(id: "work"))
    }

    func testPoppingATabsRootDoesNothing() {
        var state = NavigationState()
        state.pop()
        XCTAssertEqual(state, NavigationState())
        state.push(.note(id: "a"))
        state.pop()
        XCTAssertEqual(state, NavigationState())
    }

    func testSurvivesARoundTrip() throws {
        var state = NavigationState()
        state.push(.notebook(id: "work"))
        state.select(.library)
        state.push(.note(id: "a"))
        let json = try JSONEncoder().encode(state)
        XCTAssertEqual(try JSONDecoder().decode(NavigationState.self, from: json), state)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: json) as? [String: Any])
        XCTAssertEqual(object["tab"] as? String, "library")
        XCTAssertNotNil((object["stacks"] as? [String: Any])?["notes"])
    }

    func testRefusesAnUnknownTab() {
        let json = Data(#"{"tab":"inbox","stacks":{}}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(NavigationState.self, from: json))
    }
}
