import DevotShareInbox
import XCTest

@testable import DevotScreens

/// The app's side of the inbox: each share becomes a note through the page, then its file goes;
/// a failure keeps the file for the next time the app is in front.
@MainActor
final class ShareDrainTests: XCTestCase {
    private var folder: URL!
    private var inbox: ShareInbox!
    private var locked = false
    private var sent: [(op: Op, args: [String: JSONValue], done: (Outcome) -> Void)] = []
    private var logs: [String] = []

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "share-drain-\(UUID().uuidString)")
        inbox = ShareInbox(folder: folder)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func drain() -> ShareDrain {
        ShareDrain(
            inbox: inbox, locked: { [unowned self] in locked },
            send: { [unowned self] op, args, done in sent.append((op, args, done)) },
            log: { [unowned self] _, line in logs.append(line) })
    }

    private func item(_ title: String) -> ShareItem {
        ShareItem(title: title, text: "", url: nil, images: [])
    }

    func testTheArgumentsAreTheBridgeFixtures() throws {
        for name in ["request-share-capture", "request-share-capture-text"] {
            let url = try XCTUnwrap(
                Bundle(for: Self.self).url(forResource: "screens/valid/\(name)", withExtension: "json"), name)
            let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
            let args = try XCTUnwrap(fixture["message"]?["args"]?.object, name)
            let images = (args["images"]?.array ?? []).compactMap { image -> ShareItem.Image? in
                guard let name = image["name"]?.string, let data = image["data"]?.string.flatMap({ Data(base64Encoded: $0) })
                else { return nil }
                return ShareItem.Image(name: name, data: data)
            }
            let item = ShareItem(
                id: try XCTUnwrap(args["id"]?.string), title: try XCTUnwrap(args["title"]?.string),
                text: try XCTUnwrap(args["text"]?.string), url: args["url"]?.string, images: images)
            XCTAssertNil(item.problem(), name)
            XCTAssertEqual(ShareDrain.arguments(item), args, name)
        }
    }

    func testEachShareIsSentInTurnAndItsFileRemovedOnceTheNoteIsMade() throws {
        let first = try inbox.write(item("a"))
        let second = try inbox.write(item("b"))
        let drain = drain()
        drain.drain()
        guard sent.count == 1 else { return XCTFail("one at a time, got \(sent.count)") }
        XCTAssertEqual(sent[0].op, .shareCapture)
        XCTAssertEqual(sent[0].args["title"], .string("a"))
        sent[0].done(.ok(.object(["id": .string(ShareItem.newId()), "refused": .array([])])))
        XCTAssertEqual(inbox.pending(), [second])
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path(percentEncoded: false)))
        guard sent.count == 2 else { return XCTFail("the next share goes once the first is answered") }
        sent[1].done(.ok(.object(["id": .string(ShareItem.newId()), "refused": .array([.string("E_FILE_TOO_LARGE")])])))
        XCTAssertEqual(inbox.pending(), [])
        XCTAssertEqual(logs, ["W_SHARE_IMAGE_REFUSED code=E_FILE_TOO_LARGE"])
        XCTAssertFalse(drain.running)
    }

    func testAFailureKeepsTheFileLogsItsCodeAndGoesOn() throws {
        let first = try inbox.write(item("a"))
        let second = try inbox.write(item("b"))
        let drain = drain()
        drain.drain()
        sent[0].done(.failed("E_SCREENS_PAGE_UNREACHABLE"))
        guard sent.count == 2 else { return XCTFail("the next share still goes") }
        sent[1].done(.ok(.object(["id": .string(ShareItem.newId()), "refused": .array([])])))
        XCTAssertEqual(inbox.pending(), [first])
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.path(percentEncoded: false)))
        XCTAssertEqual(logs, ["W_SHARE_DRAIN_FAILED code=E_SCREENS_PAGE_UNREACHABLE"])
    }

    func testLockedEditingSendsNothingAndKeepsEveryShare() throws {
        try inbox.write(item("a"))
        locked = true
        let drain = drain()
        drain.drain()
        XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(inbox.pending().count, 1)
        XCTAssertEqual(logs, ["I_SHARE_DRAIN_LOCKED count=1"])
        XCTAssertFalse(drain.running)
    }

    func testALicenceRefusalStopsTheDrainWithTheRestKept() throws {
        try inbox.write(item("a"))
        try inbox.write(item("b"))
        let drain = drain()
        drain.drain()
        sent[0].done(.failed("E_LICENCE_REQUIRED"))
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(inbox.pending().count, 2)
        XCTAssertEqual(logs, ["W_SHARE_DRAIN_FAILED code=E_LICENCE_REQUIRED"])
        XCTAssertFalse(drain.running)
    }

    func testAnUnreadableFileIsKeptAndSkipped() throws {
        let broken = folder.appending(path: "\(ShareItem.newId(now: Date(timeIntervalSince1970: 1))).json")
        try inbox.write(item("a"))
        try Data("{".utf8).write(to: broken)
        let drain = drain()
        drain.drain()
        XCTAssertEqual(logs, ["W_SHARE_DRAIN_FAILED code=E_SHARE_FILE_UNREADABLE"])
        guard sent.count == 1 else { return XCTFail("the readable share still goes") }
        sent[0].done(.ok(.object(["id": .string(ShareItem.newId()), "refused": .array([])])))
        XCTAssertEqual(inbox.pending(), [broken])
    }

    func testADrainAskedForWhileOneRunsRunsOnceMoreAfterIt() throws {
        try inbox.write(item("a"))
        let drain = drain()
        drain.drain()
        try inbox.write(item("b"))
        drain.drain()
        XCTAssertEqual(sent.count, 1, "no second share while the first waits")
        sent[0].done(.ok(.object(["id": .string(ShareItem.newId()), "refused": .array([])])))
        guard sent.count == 2 else { return XCTFail("the later share goes in the next pass") }
        XCTAssertEqual(sent[1].args["title"], .string("b"))
        sent[1].done(.ok(.object(["id": .string(ShareItem.newId()), "refused": .array([])])))
        XCTAssertEqual(inbox.pending(), [])
        XCTAssertFalse(drain.running)
    }

    func testNoInboxDoesNothing() {
        let drain = ShareDrain(inbox: nil, locked: { false }, send: { _, _, _ in XCTFail("nothing to send") }, log: { _, _ in })
        drain.drain()
        XCTAssertFalse(drain.running)
    }
}
