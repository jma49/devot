import XCTest

@testable import DevotScreens

@MainActor
final class SliderCommitTests: XCTestCase {
    private var released = 0
    private lazy var commit = SliderCommit(settle: .milliseconds(20))

    private func wait(_ seconds: TimeInterval = 0.1) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    func testADragIsWrittenOnceWhenTheFingerLifts() {
        commit.editing(true) { self.released += 1 }
        for _ in 0..<3 { commit.changed { self.released += 1 } }
        wait()
        XCTAssertEqual(released, 0)
        commit.editing(false) { self.released += 1 }
        wait()
        XCTAssertEqual(released, 1)
    }

    /// VoiceOver and Switch Control step the value without touch tracking.
    func testStepsWithoutADragAreWrittenOnceTheySettle() {
        commit.changed { self.released += 1 }
        commit.changed { self.released += 1 }
        XCTAssertEqual(released, 0)
        wait()
        XCTAssertEqual(released, 1)
    }

    func testADragThatStartsBeforeTheStepsSettleTakesThemOver() {
        commit.changed { self.released += 1 }
        commit.editing(true) { self.released += 1 }
        wait()
        XCTAssertEqual(released, 0)
        commit.editing(false) { self.released += 1 }
        XCTAssertEqual(released, 1)
    }
}
