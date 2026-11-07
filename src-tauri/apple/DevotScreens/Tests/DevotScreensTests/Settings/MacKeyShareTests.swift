import XCTest

@testable import DevotScreens

@MainActor
final class MacKeyShareTests: XCTestCase {
    func testSharesTheCatalogMessageAndTheLinkThatAddsTheKeyOnAMac() throws {
        let key = "devot1.eyJpZCI6IjEifQ.c2ln-_"
        let items = MacKeyShare.items(key: key)
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items.first as? String, L10n.phoneMacKeyShareText(key: key))
        let link = try XCTUnwrap(items.last as? URL)
        XCTAssertEqual(link.absoluteString, "devot://licence?key=\(key)")
    }

    func testEncodesWhatALinkCannotCarryAsThePageDoes() throws {
        let link = try XCTUnwrap(MacKeyShare.items(key: "a+b/c=").last as? URL)
        XCTAssertEqual(link.absoluteString, "devot://licence?key=a%2Bb%2Fc%3D")
    }
}
