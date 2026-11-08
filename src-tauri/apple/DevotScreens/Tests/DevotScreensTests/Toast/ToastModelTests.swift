import XCTest

@testable import DevotScreens

/// When a dragged toast goes and how fast (design/motion.md, Undo toast).
final class ToastModelTests: XCTestCase {
    private let width: CGFloat = 300

    private func release(_ translation: CGFloat, _ velocity: CGFloat = 0) -> ToastModel.Release {
        ToastModel.release(translation: translation, velocity: velocity, width: width)
    }

    private func goes(_ release: ToastModel.Release) -> Bool {
        if case .fly = release { return true }
        return false
    }

    func testTheThresholdsAreTheTokens() {
        XCTAssertEqual(Tokens.Ratio.phoneToastDismiss, 0.25)
        XCTAssertEqual(Tokens.Velocity.phoneToastFlick, 800)
    }

    func testAQuarterOfItsWidthEitherWay() {
        XCTAssertFalse(goes(release(72)))
        XCTAssertTrue(goes(release(78)))
        XCTAssertFalse(goes(release(-72)))
        XCTAssertTrue(goes(release(-78)))
    }

    func testAFlickInTheDirectionOfTheDrag() {
        XCTAssertFalse(goes(release(10, 799)))
        XCTAssertTrue(goes(release(10, 801)))
        XCTAssertFalse(goes(release(-10, -799)))
        XCTAssertTrue(goes(release(-10, -801)))
    }

    func testAFlickAgainstTheDragNeverCounts() {
        XCTAssertFalse(goes(release(10, -5000)))
        XCTAssertFalse(goes(release(-10, 5000)))
        XCTAssertFalse(goes(release(0, 5000)))
    }

    func testItFliesToItsWidthPlus24AtTheFasterOfTheFingerAndWhatTakesAtMost160Milliseconds() {
        guard case .fly(let target, let speed, let duration) = release(100, 0) else { return XCTFail("stays") }
        XCTAssertEqual(target, 324)
        XCTAssertEqual(speed, (324 - 100) / 0.16, accuracy: 0.001)
        XCTAssertEqual(duration, 0.16, accuracy: 0.0001)
        guard case .fly(let leftTarget, _, _) = release(-100, 0) else { return XCTFail("stays") }
        XCTAssertEqual(leftTarget, -324)
    }

    func testAFasterFingerIsNeverSlowedDown() {
        guard case .fly(_, let speed, let duration) = release(100, 3000) else { return XCTFail("stays") }
        XCTAssertEqual(speed, 3000)
        XCTAssertEqual(duration, (324 - 100) / 3000, accuracy: 0.0001)
        guard case .fly(_, let leftSpeed, _) = release(-100, -3000) else { return XCTFail("stays") }
        XCTAssertEqual(leftSpeed, 3000)
    }

    func testAFarDragWithTheFingerGoingBackStillFliesAtTheFixedTime() {
        guard case .fly(_, let speed, let duration) = release(120, -400) else { return XCTFail("stays") }
        XCTAssertEqual(speed, (324 - 120) / 0.16, accuracy: 0.001)
        XCTAssertLessThanOrEqual(duration, 0.16 + 0.0001)
    }

    func testAnythingElseSettlesFromTheFingersSpeed() {
        XCTAssertEqual(release(40, -300), .settle(velocity: -300))
    }

    func testThePanBeginsSidewaysAndFailsOnceItGoesUpOrDown() {
        XCTAssertTrue(ToastModel.panBegins(CGPoint(x: 11, y: 3)))
        XCTAssertTrue(ToastModel.panBegins(CGPoint(x: -12, y: -12)))
        XCTAssertFalse(ToastModel.panBegins(CGPoint(x: 30, y: 13)))
        XCTAssertFalse(ToastModel.panBegins(CGPoint(x: 3, y: 11)))
    }
}
