import XCTest

extension XCUIApplication {
    /// Launches the app and stops it when `test` ends, pass or fail. A failed UI test ends the test
    /// process, and xcodebuild starts a new one for the next test; an app the failed test left running
    /// was then stopped by a session that never watched it, which waited out its 60 seconds and failed
    /// the next test with "Failed to terminate" (#966, after #967 in run 43820625400).
    func launch(stoppedAfter test: XCTestCase) {
        launch()
        test.addTeardownBlock { @MainActor [self] in
            guard state != .notRunning else { return }
            terminate()
            XCTAssertTrue(wait(for: .notRunning, timeout: waitLimit(10)), "the app stops")
        }
    }
}
