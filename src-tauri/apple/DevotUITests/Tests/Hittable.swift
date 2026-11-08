import XCTest

extension XCUIElement {
    /// Right after a launch the tab bar is in the tree before its items have a place on screen, and a
    /// tap then lands nowhere (XCTest logs the hit point {-1, -1}) and is lost. `isHittable` fails on
    /// an element that is not in the tree, so the wait for it starts once the element exists.
    @MainActor
    func tapOnceHittable(timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(waitForExistence(timeout: timeout), "\(self) exists", file: file, line: line)
        XCTAssertTrue(
            wait(for: \.isHittable, toEqual: true, timeout: timeout), "\(self) takes a tap", file: file, line: line)
        tap()
    }
}
