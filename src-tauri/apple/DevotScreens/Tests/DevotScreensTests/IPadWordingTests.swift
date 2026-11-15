import XCTest

@testable import DevotScreens

final class IPadWordingTests: XCTestCase {
    override func tearDown() {
        L10n.onIPad = false
        super.tearDown()
    }

    func testAnIPadNamesItselfInsteadOfTheIPhone() {
        let phone = L10n.usageStorage()
        XCTAssertTrue(phone.contains("iPhone"))
        L10n.onIPad = true
        XCTAssertEqual(L10n.usageStorage(), phone.replacingOccurrences(of: "iPhone", with: "iPad"))
    }
}
