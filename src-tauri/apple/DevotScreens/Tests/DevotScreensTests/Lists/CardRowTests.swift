import UIKit
import XCTest

@testable import DevotScreens

/// Grouped cards, the heatmap and the week's control take the theme's colours, not the system's grey and teal.
@MainActor
final class CardRowTests: XCTestCase {
    private let dark = UITraitCollection(userInterfaceStyle: .dark)

    override func tearDown() {
        Tokens.Theme.current = .default
        super.tearDown()
    }

    private func assertColor(
        _ color: UIColor?, _ hex: UInt32, _ alpha: CGFloat = 1, file: StaticString = #filePath, line: UInt = #line
    ) {
        guard let color else { return XCTFail("no colour", file: file, line: line) }
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        color.resolvedColor(with: dark).getRed(&r, green: &g, blue: &b, alpha: &a)
        let want = [CGFloat((hex >> 16) & 0xff) / 255, CGFloat((hex >> 8) & 0xff) / 255, CGFloat(hex & 0xff) / 255, alpha]
        for (got, wanted) in zip([r, g, b, a], want) {
            XCTAssertEqual(got, wanted, accuracy: 0.002, file: file, line: line)
        }
    }

    private func background(_ cell: UICollectionViewListCell) -> UIColor? {
        cell.configurationUpdateHandler?(cell, cell.configurationState)
        return cell.backgroundConfiguration?.backgroundColor
    }

    func testAGroupedRowTakesTheThemesCardAndThePressedFillWhenTouched() {
        Tokens.Theme.current = .dawn
        let cell = UICollectionViewListCell(frame: CGRect(x: 0, y: 0, width: 390, height: 44))
        cell.paintAsCard()
        assertColor(background(cell), 0xee7fa6, 0.08)
        cell.isHighlighted = true
        XCTAssertEqual(
            background(cell)?.resolvedColor(with: dark), Tokens.Color.phonePressed.resolvedColor(with: dark))
    }

    func testTheActivityCardsTakeTheCardColour() {
        Tokens.Theme.current = .ember
        assertColor(background(HeatmapCell(frame: .zero)), 0xf39a52, 0.08)
        assertColor(background(FiguresCell(frame: .zero)), 0xf39a52, 0.08)
    }

    func testAGradientThemeShadesTheHeatmapAndTheWeekInItsAccentAndTheDefaultKeepsTeal() {
        Tokens.Theme.current = .dawn
        assertColor(Tokens.Color.activityLevel1, 0xee7fa6, 0.25)
        assertColor(Tokens.Color.activityLevel4, 0xee7fa6)
        let figures = FiguresCell(frame: .zero)
        assertColor(figures.period.backgroundColor, 0xee7fa6, 0.12)
        assertColor(figures.period.selectedSegmentTintColor, 0xee7fa6, 0.3)
        Tokens.Theme.current = .default
        assertColor(Tokens.Color.activityLevel4, 0x63cdbf)
        assertColor(Tokens.Color.phoneSegmentSelected, 0x636366)
    }
}
