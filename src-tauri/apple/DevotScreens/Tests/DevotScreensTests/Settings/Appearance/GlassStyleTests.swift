import XCTest

@testable import DevotScreens

final class GlassStyleTests: XCTestCase {
    func testMapsTheTransparencyOntoTheGlass() {
        XCTAssertEqual(GlassStyle.for(transparency: -100), .solid)
        XCTAssertEqual(GlassStyle.for(transparency: -50), .regular(tint: 0.5))
        XCTAssertEqual(GlassStyle.for(transparency: -5), .regular(tint: 0.05))
        XCTAssertEqual(GlassStyle.for(transparency: 0), .regular(tint: 0))
        XCTAssertEqual(GlassStyle.for(transparency: 5), .clear(tint: 0.2375))
        XCTAssertEqual(GlassStyle.for(transparency: 50), .clear(tint: 0.125))
        XCTAssertEqual(GlassStyle.for(transparency: 100), .clear(tint: 0))
    }

    func testReduceTransparencyMakesItSolidWhateverTheSlider() {
        XCTAssertEqual(GlassStyle.for(transparency: 100, reduced: true), .solid)
        XCTAssertEqual(GlassStyle.for(transparency: 0, reduced: true), .solid)
    }

    func testFirmsTheSystemBarsOnlyBelowZero() {
        for t in [-100, -50, -5] { XCTAssertEqual(GlassStyle.barEdge(transparency: t), .hard, "\(t)") }
        for t in [0, 5, 50, 100] { XCTAssertEqual(GlassStyle.barEdge(transparency: t), .automatic, "\(t)") }
    }

    func testKeepsAStoredValueOnTheSlidersSteps() {
        XCTAssertEqual(GlassStyle.clamp(-140), -100)
        XCTAssertEqual(GlassStyle.clamp(140), 100)
        XCTAssertEqual(GlassStyle.clamp(23), 25)
        XCTAssertEqual(GlassStyle.clamp(-22), -20)
    }
}
