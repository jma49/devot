import XCTest

@testable import DevotScreens

final class MotionPolicyTests: XCTestCase {
    func testAnimationsChoiceAgainstReduceMotion() {
        XCTAssertFalse(MotionPolicy(animations: "always").reduced(systemReduceMotion: true))
        XCTAssertFalse(MotionPolicy(animations: "always").reduced(systemReduceMotion: false))
        XCTAssertTrue(MotionPolicy(animations: "system").reduced(systemReduceMotion: true))
        XCTAssertFalse(MotionPolicy(animations: "system").reduced(systemReduceMotion: false))
        XCTAssertTrue(MotionPolicy(animations: "off").reduced(systemReduceMotion: true))
        XCTAssertTrue(MotionPolicy(animations: "off").reduced(systemReduceMotion: false))
    }

    func testAnUnknownOrMissingChoiceFollowsTheSystem() {
        XCTAssertTrue(MotionPolicy(animations: nil).reduced(systemReduceMotion: true))
        XCTAssertFalse(MotionPolicy(animations: "sometimes").reduced(systemReduceMotion: false))
    }

    func testReadsTheChoiceFromTheEditorSettings() {
        XCTAssertEqual(MotionPolicy(editor: ["animations": .string("off")]), MotionPolicy(animations: "off"))
    }
}
