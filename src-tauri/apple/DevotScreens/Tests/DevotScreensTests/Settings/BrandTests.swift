import UIKit
import XCTest

@testable import DevotScreens

/// The Settings app card and the Pro sheets draw Devot's own icon and dove, not a system symbol.
@MainActor
final class BrandTests: XCTestCase {
    private func pixels(_ name: String, side: CGFloat = 64) throws -> (UIImage, (CGFloat, CGFloat) -> UIColor) {
        let image = try XCTUnwrap(UIImage(named: name, in: .module, with: nil), "\(name) is in the package's assets")
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let drawn = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            image.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }
        let data = try XCTUnwrap(drawn.cgImage?.dataProvider?.data as Data?)
        let row = try XCTUnwrap(drawn.cgImage?.bytesPerRow)
        return (drawn, { x, y in
            let i = Int(y) * row + Int(x) * 4
            return UIColor(red: CGFloat(data[i]) / 255, green: CGFloat(data[i + 1]) / 255, blue: CGFloat(data[i + 2]) / 255, alpha: 1)
        })
    }

    private func isTeal(_ color: UIColor) -> Bool {
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        // The renderer may store BGRA, so the teal is told by its shape: one channel low, two close and mid.
        let sorted = [r, g, b].sorted()
        return sorted[0] < 0.2 && sorted[1] > 0.3 && sorted[2] < 0.6 && sorted[2] - sorted[1] < 0.1
    }

    func testTheAppMarkIsTheIconsDoveOnItsLightTile() throws {
        let (_, at) = try pixels(Brand.appMark)
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        at(2, 2).getRed(&r, green: &g, blue: &b, alpha: &a)
        XCTAssertGreaterThan(min(r, g, b), 0.9, "the tile is light")
        let teal = (0..<64).flatMap { y in (0..<64).map { x in at(CGFloat(x), CGFloat(y)) } }.filter(isTeal)
        XCTAssertGreaterThan(teal.count, 200, "the dove is drawn in its teal")
    }

    func testTheDoveIsDrawnInItsTeal() throws {
        let (_, at) = try pixels(Brand.dove)
        let teal = (0..<64).flatMap { y in (0..<64).map { x in at(CGFloat(x), CGFloat(y)) } }.filter(isTeal)
        XCTAssertGreaterThan(teal.count, 300)
    }
}
