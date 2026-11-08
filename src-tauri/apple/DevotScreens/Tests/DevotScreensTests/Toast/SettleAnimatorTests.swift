import UIKit
import XCTest

@testable import DevotScreens

/// `phone-settle` released with a velocity: the closed form, stopped at the first crossing.
@MainActor
final class SettleAnimatorTests: XCTestCase {
    private func samples(_ curve: SettleCurve, upTo seconds: TimeInterval = 1) -> [(time: TimeInterval, value: CGFloat, finished: Bool)] {
        stride(from: 0, through: seconds, by: 0.001).map { time in
            let (value, finished) = curve.clamped(at: time)
            return (time, value, finished)
        }
    }

    func testFromRestItIsWithinTwoPercentByTwoTenthsOfASecondAndStaysThere() {
        let curve = SettleCurve(from: 100, to: 0, velocity: 0)
        for sample in samples(curve) where sample.time >= 0.22 {
            XCTAssertLessThanOrEqual(abs(sample.value), 2, "t=\(sample.time)")
        }
        XCTAssertGreaterThan(abs(curve.free(at: 0.05)), 20)
    }

    func testTheSpringIsTheTokensOwn() {
        let spring = Tokens.Spring.phoneSettle
        let omega = (spring.stiffness / spring.mass).squareRoot()
        let zeta = spring.damping / (2 * (spring.stiffness * spring.mass).squareRoot())
        XCTAssertEqual(omega, 21.7, accuracy: 0.1)
        XCTAssertEqual(zeta, 0.855, accuracy: 0.002)
    }

    func testReleasedNearRestAt800PointsASecondItWouldPassItsPlaceAndTheClampStopsItThere() {
        let curve = SettleCurve(from: 5, to: 0, velocity: -800)
        let farthest = samples(curve).map { curve.free(at: $0.time) }.min() ?? 0
        XCTAssertLessThan(farthest, -10, "the free spring overshoots by more than 10 pt")
        let clamped = samples(curve)
        XCTAssertTrue(clamped.allSatisfy { $0.value >= 0 }, "the clamped one never goes below its place")
        XCTAssertEqual(clamped.last?.value, 0)
        XCTAssertEqual(clamped.last?.finished, true)
        let first = clamped.first { $0.finished }
        XCTAssertEqual(first?.value, 0)
        XCTAssertLessThan(first?.time ?? 1, 0.05)
    }

    func testAnotherSideAndAReleaseAwayFromThePlaceStopAtTheFirstCrossing() {
        let left = SettleCurve(from: -40, to: 0, velocity: 800)
        XCTAssertTrue(samples(left).allSatisfy { $0.value <= 0 })
        let away = SettleCurve(from: 20, to: 0, velocity: 800)
        let values = samples(away).map(\.value)
        XCTAssertGreaterThan(values.max() ?? 0, 20, "it first goes on the way the finger was going")
        XCTAssertTrue(values.allSatisfy { $0 >= 0 })
        XCTAssertEqual(values.last, 0)
    }

    func testAViewAtItsPlaceIsDoneAtOnce() {
        XCTAssertTrue(SettleCurve(from: 0, to: 0, velocity: 500).clamped(at: 0).finished)
    }

    func testItMovesTheTransformAndNothingElse() throws {
        let view = UIView(frame: CGRect(x: 16, y: 600, width: 300, height: 48))
        view.alpha = 0.7
        let bounds = view.bounds
        let center = view.center
        var finished = 0
        let animator = SettleAnimator(view: view, from: 90, velocity: -300) { finished += 1 }
        var elapsed: TimeInterval = 0
        while animator.step(elapsed: elapsed) { elapsed += 1.0 / 120 }
        XCTAssertEqual(finished, 1)
        XCTAssertEqual(view.transform, CGAffineTransform(translationX: 0, y: 0))
        XCTAssertEqual(view.bounds, bounds)
        XCTAssertEqual(view.center, center)
        XCTAssertEqual(view.alpha, 0.7, accuracy: 0.001)
        XCTAssertFalse(animator.step(elapsed: elapsed + 1), "a finished animator does nothing more")
        XCTAssertEqual(finished, 1)
    }

    func testEveryFrameAlongTheWayMovesTheTransformOnly() {
        let view = UIView(frame: CGRect(x: 0, y: 0, width: 300, height: 48))
        var seen: [CGFloat] = []
        let animator = SettleAnimator(from: 80, to: 0, velocity: 0) { value in
            seen.append(value)
            view.transform = CGAffineTransform(translationX: value, y: 0)
            XCTAssertEqual(view.transform.ty, 0)
            XCTAssertEqual(view.transform.a, 1)
        }
        var elapsed: TimeInterval = 0
        while animator.step(elapsed: elapsed) { elapsed += 1.0 / 120 }
        XCTAssertEqual(seen.first, 80)
        XCTAssertEqual(seen.last, 0)
        XCTAssertLessThan(elapsed, 0.4)
    }

    func testACancelledAnimatorLeavesTheViewWhereItWas() {
        let view = UIView()
        let animator = SettleAnimator(view: view, from: 50, velocity: 0)
        animator.step(elapsed: 0.05)
        let moved = view.transform
        animator.cancel()
        XCTAssertFalse(animator.step(elapsed: 0.2))
        XCTAssertEqual(view.transform, moved)
    }
}
