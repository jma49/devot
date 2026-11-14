import DevotShareInbox
import ImageIO
import UIKit
import XCTest

/// The inbox file the Share Extension writes and the app drains (docs/specs/share-extension.md).
final class ShareInboxTests: XCTestCase {
    private var folder: URL!
    private var inbox: ShareInbox!
    static let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "share-inbox-\(UUID().uuidString)")
        inbox = ShareInbox(folder: folder)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testAnItemIsWrittenWholeUnderItsIdAndReadBack() throws {
        let item = ShareItem(
            title: "An article", text: "Worth reading.", url: "https://example.com/a",
            images: [ShareItem.Image(name: "image-1.jpg", data: Self.jpeg)])
        let file = try inbox.write(item)
        XCTAssertEqual(file.lastPathComponent, "\(item.id).json")
        XCTAssertEqual(inbox.pending(), [file])
        XCTAssertEqual(try inbox.read(file), item)
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false))
        XCTAssertEqual(names, [file.lastPathComponent], "no temp file is left")
        let protection = try FileManager.default.attributesOfItem(atPath: file.path(percentEncoded: false))[.protectionKey]
        #if !targetEnvironment(simulator)
            XCTAssertEqual(protection as? FileProtectionType, .complete)
        #else
            _ = protection
        #endif
        XCTAssertEqual(try folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testTheFileIsTheBridgeArgumentsWithAVersion() throws {
        let item = ShareItem(
            id: "01890a5d-ac96-774b-bcce-b302099a8057", title: "T", text: "x", url: nil,
            images: [ShareItem.Image(name: "image-1.jpg", data: Self.jpeg)])
        let json = try JSONSerialization.jsonObject(with: item.encoded()) as? [String: Any]
        XCTAssertEqual(json?.keys.sorted(), ["id", "images", "text", "title", "v"])
        XCTAssertEqual(json?["v"] as? Int, 1)
        let images = json?["images"] as? [[String: String]]
        XCTAssertEqual(images?.first?["data"], Self.jpeg.base64EncodedString())
    }

    func testPendingIsOldestFirstAndSkipsTempFiles() throws {
        let later = ShareItem(id: ShareItem.newId(now: Date(timeIntervalSince1970: 2_000_000_000)), title: "b", text: "", url: nil, images: [])
        let earlier = ShareItem(id: ShareItem.newId(now: Date(timeIntervalSince1970: 1_000_000_000)), title: "a", text: "", url: nil, images: [])
        try inbox.write(later)
        try inbox.write(earlier)
        try Data("{".utf8).write(to: folder.appending(path: ".half.tmp"))
        XCTAssertEqual(inbox.pending().map(\.lastPathComponent), ["\(earlier.id).json", "\(later.id).json"])
    }

    func testAnOldTempFileIsSweptAndANewOneKept() throws {
        try inbox.write(ShareItem(title: "a", text: "", url: nil, images: []))
        let temp = folder.appending(path: ".left.tmp")
        try Data("{".utf8).write(to: temp)
        inbox.sweep(now: Date().addingTimeInterval(60))
        XCTAssertTrue(FileManager.default.fileExists(atPath: temp.path(percentEncoded: false)))
        inbox.sweep(now: Date().addingTimeInterval(2 * 60 * 60))
        XCTAssertFalse(FileManager.default.fileExists(atPath: temp.path(percentEncoded: false)))
        XCTAssertEqual(inbox.pending().count, 1)
    }

    func testTheInboxRefusesWhatTheBridgeWould() {
        let jpeg = ShareItem.Image(name: "a.jpg", data: Self.jpeg)
        let cases: [(ShareItem, String)] = [
            (ShareItem(title: " ", text: "\n", url: nil, images: []), "E_SHARE_EMPTY"),
            (ShareItem(id: "01890a5d-ac96-474b-bcce-b302099a8057", title: "a", text: "", url: nil, images: []), "E_SHARE_ID_INVALID"),
            (ShareItem(id: "01890A5D-AC96-774B-BCCE-B302099A8057", title: "a", text: "", url: nil, images: []), "E_SHARE_ID_INVALID"),
            (ShareItem(title: String(repeating: "t", count: 1_001), text: "", url: nil, images: []), "E_SHARE_TITLE_TOO_LONG"),
            (ShareItem(title: "", text: String(repeating: "x", count: 100_001), url: nil, images: []), "E_SHARE_TEXT_TOO_LONG"),
            (ShareItem(title: "", text: "", url: "file:///etc/hosts", images: []), "E_SHARE_URL_INVALID"),
            (ShareItem(title: "", text: "", url: "https://a.b/c d", images: []), "E_SHARE_URL_INVALID"),
            (ShareItem(title: "", text: "", url: nil, images: Array(repeating: jpeg, count: 5)), "E_SHARE_IMAGES_TOO_MANY"),
            (ShareItem(title: "", text: "", url: nil, images: [ShareItem.Image(name: "a.png", data: Data([0x89, 0x50]))]), "E_SHARE_IMAGE_INVALID"),
            (ShareItem(title: "", text: "", url: nil, images: [ShareItem.Image(name: "", data: Self.jpeg)]), "E_SHARE_IMAGE_INVALID"),
        ]
        for (item, code) in cases {
            XCTAssertThrowsError(try inbox.write(item), code) { XCTAssertEqual(($0 as? ShareError)?.code, code) }
        }
        XCTAssertEqual(inbox.pending(), [])
        XCTAssertNil(ShareItem(title: "", text: "", url: "https://example.com", images: []).problem())
    }

    func testAFileTooLargeIsNeverWritten() {
        let big = ShareItem.Image(name: "a.jpg", data: Self.jpeg + Data(count: ShareItem.maxFileBytes))
        XCTAssertThrowsError(try inbox.write(ShareItem(title: "a", text: "", url: nil, images: [big]))) {
            XCTAssertEqual(($0 as? ShareError)?.code, "E_SHARE_TOO_LARGE")
        }
    }

    func testAFullInboxRefusesMore() throws {
        for _ in 0..<ShareInbox.capacity { try inbox.write(ShareItem(title: "a", text: "", url: nil, images: [])) }
        XCTAssertThrowsError(try inbox.write(ShareItem(title: "a", text: "", url: nil, images: []))) {
            XCTAssertEqual(($0 as? ShareError)?.code, "E_SHARE_INBOX_FULL")
        }
    }

    func testAFileRenamedOrBrokenIsRefusedOnRead() throws {
        let file = try inbox.write(ShareItem(title: "a", text: "", url: nil, images: []))
        let moved = folder.appending(path: "\(ShareItem.newId()).json")
        try FileManager.default.moveItem(at: file, to: moved)
        XCTAssertThrowsError(try inbox.read(moved)) { XCTAssertEqual(($0 as? ShareError)?.code, "E_SHARE_ID_INVALID") }
        try Data("{\"v\":1".utf8).write(to: moved)
        XCTAssertThrowsError(try inbox.read(moved)) { XCTAssertEqual(($0 as? ShareError)?.code, "E_SHARE_FILE_UNREADABLE") }
    }

    func testANewIdIsAVersion7UUIDInTimeOrder() {
        let a = ShareItem.newId(now: Date(timeIntervalSince1970: 1_700_000_000))
        let b = ShareItem.newId(now: Date(timeIntervalSince1970: 1_700_000_001))
        XCTAssertTrue(ShareItem.isNoteId(a))
        XCTAssertTrue(a < b)
        XCTAssertTrue(a.hasPrefix("018bcfe5-6800-7"))
    }

    func testImagesAreScaledToJPEGWithinTheBudget() throws {
        let png = try XCTUnwrap(Self.png(width: 4_000, height: 1_000))
        let (images, skipped) = ShareImages.prepare([png, Data("not an image".utf8)])
        XCTAssertEqual(skipped, 1)
        guard images.count == 1 else { return XCTFail("expected one image, got \(images.count)") }
        XCTAssertEqual(images[0].name, "image-1.jpg")
        XCTAssertNil(ShareItem(title: "", text: "", url: nil, images: images).problem())
        let source = try XCTUnwrap(CGImageSourceCreateWithData(images[0].data as CFData, nil))
        let size = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        XCTAssertEqual(size[kCGImagePropertyPixelWidth] as? Int, 2_048)
        XCTAssertNil(size[kCGImagePropertyGPSDictionary])
        XCTAssertLessThanOrEqual(images[0].data.count, ShareImages.budget)
    }

    static func png(width: Int, height: Int) -> Data? {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return format
        }())
        return renderer.pngData { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }
}
