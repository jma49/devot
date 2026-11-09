import UIKit
import XCTest

@testable import DevotScreens

/// The Settings app card and the Pro sheets draw Devot's own icon and dove, not a system symbol.
@MainActor
final class BrandTests: XCTestCase {
    private func pixels(_ name: String, side: CGFloat = 64) throws -> (CGFloat, CGFloat) -> [CGFloat] {
        let image = try XCTUnwrap(UIImage(named: name, in: .module, with: nil), "\(name) is in the package's assets")
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let drawn = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            image.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }
        let data = try XCTUnwrap(drawn.cgImage?.dataProvider?.data as Data?)
        let row = try XCTUnwrap(drawn.cgImage?.bytesPerRow)
        return { x, y in
            let i = Int(y) * row + Int(x) * 4
            return (0..<3).map { CGFloat(data[i + $0]) / 255 }
        }
    }

    private func isTeal(_ channels: [CGFloat]) -> Bool {
        // The renderer may store BGRA, so the teal is told by its shape: one channel low, two close and mid.
        let sorted = channels.sorted()
        return sorted[0] < 0.2 && sorted[1] > 0.3 && sorted[2] < 0.6 && sorted[2] - sorted[1] < 0.1
    }

    func testTheAppMarkIsTheIconsDoveOnItsLightTile() throws {
        let at = try pixels(Brand.appMark)
        XCTAssertGreaterThan(at(2, 2).min() ?? 0, 0.9, "the tile is light")
        let teal = (0..<64).flatMap { y in (0..<64).map { x in at(CGFloat(x), CGFloat(y)) } }.filter(isTeal)
        XCTAssertGreaterThan(teal.count, 200, "the dove is drawn in its teal")
    }

    func testTheDoveIsDrawnInItsTeal() throws {
        let at = try pixels(Brand.dove)
        let teal = (0..<64).flatMap { y in (0..<64).map { x in at(CGFloat(x), CGFloat(y)) } }.filter(isTeal)
        XCTAssertGreaterThan(teal.count, 300)
    }
}
