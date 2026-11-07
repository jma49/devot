import SwiftUI
import UIKit
import XCTest

@testable import DevotScreens

@MainActor
final class ContentSheetTests: XCTestCase {
    func testTheSheetIsAsTallAsItsContentUpToNearlyTheWholeHeight() {
        XCTAssertEqual(ContentSheetController.height(content: 300, maximum: 800), 300)
        XCTAssertEqual(ContentSheetController.height(content: 2000, maximum: 800), 800 * 0.92, accuracy: 0.001)
    }

    func testOneDetentWithAGrabberThatScrollingNeverGrows() throws {
        let sheet = ContentSheetController(Text(verbatim: "x"))
        let presentation = try XCTUnwrap(sheet.sheetPresentationController)
        XCTAssertEqual(presentation.detents.map(\.identifier), [ContentSheetController.detent])
        XCTAssertTrue(presentation.prefersGrabberVisible)
        XCTAssertFalse(presentation.prefersScrollingExpandsWhenScrolledToEdge)
    }

    func testTallerContentMakesATallerSheet() {
        let short = ContentSheetController(Text(verbatim: "x"))
        let tall = ContentSheetController(VStack { ForEach(0..<8) { Text(verbatim: "\($0)") } })
        for sheet in [short, tall] {
            sheet.loadViewIfNeeded()
            sheet.view.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        }
        XCTAssertGreaterThan(tall.contentHeight, short.contentHeight)
        XCTAssertGreaterThan(short.contentHeight, 0)
    }
}
