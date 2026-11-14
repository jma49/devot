import DevotShareInbox
import XCTest

/// What the Add to Devot action writes into the inbox (docs/specs/share-extension.md, Shortcuts).
final class ShareAddTests: XCTestCase {
    private var folder: URL!
    private var inbox: ShareInbox!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "share-add-\(UUID().uuidString)")
        inbox = ShareInbox(folder: folder)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testTheActionWritesOneItemTheDrainReadsBack() throws {
        let item = try inbox.add(title: "  Groceries \n", text: "Milk\nEggs", url: "https://example.com/list")
        XCTAssertEqual(item.title, "Groceries")
        XCTAssertEqual(item.text, "Milk\nEggs")
        XCTAssertEqual(item.url, "https://example.com/list")
        XCTAssertEqual(item.images, [])
        XCTAssertEqual(try inbox.pending().map { try inbox.read($0) }, [item])
    }

    func testABlankTitleAndURLAreLeftOut() throws {
        let item = try inbox.add(title: " ", text: "Call Ana", url: "  ")
        XCTAssertEqual(item.title, "")
        XCTAssertNil(item.url)
    }

    func testNothingToAddIsRefusedAndWritesNothing() {
        XCTAssertThrowsError(try inbox.add(title: " ", text: " \n", url: nil)) { error in
            XCTAssertEqual((error as? ShareError)?.code, "E_SHARE_EMPTY")
        }
        XCTAssertEqual(inbox.pending(), [])
    }

    func testALinkThatIsNotOnTheWebIsRefused() {
        XCTAssertThrowsError(try inbox.add(title: "", text: "x", url: "file:///etc/hosts")) { error in
            XCTAssertEqual((error as? ShareError)?.code, "E_SHARE_URL_INVALID")
        }
        XCTAssertEqual(inbox.pending(), [])
    }

    func testTextOverTheLimitIsRefused() {
        let long = String(repeating: "a", count: ShareItem.maxTextChars + 1)
        XCTAssertThrowsError(try inbox.add(title: "", text: long, url: nil)) { error in
            XCTAssertEqual((error as? ShareError)?.code, "E_SHARE_TEXT_TOO_LONG")
        }
    }
}
