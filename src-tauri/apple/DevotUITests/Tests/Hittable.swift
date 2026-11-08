import XCTest

extension XCUIElement {
    /// Right after a launch the tab bar is in the tree before its items have a place on screen, and a
    /// tap then lands nowhere (XCTest logs the hit point {-1, -1}) and is lost.
    @MainActor
    func tapOnceHittable(timeout: TimeInterval = 10) {
        XCTAssertTrue(wait(for: \.isHittable, toEqual: true, timeout: timeout), "\(identifier) takes a tap")
        tap()
    }
}
