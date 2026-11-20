import SwiftUI
import UIKit
import XCTest

@testable import DevotScreens

/// Stands in for the system's speech model: the test says when a start returns and what is heard.
@MainActor
final class FakeListener: SpeechListening {
    var starts: [Locale] = []
    var finishes = 0
    var cancels = 0
    var failure: SpeechFailure?
    var downloads = false
    private(set) var heard: (@MainActor @Sendable (SpeechHeard) -> Void)?
    /// What `finish` hears before it returns, as the model settles the last words.
    var lastWords: SpeechHeard?

    func start(
        locale: Locale, downloading: @escaping @MainActor @Sendable () -> Void,
        heard: @escaping @MainActor @Sendable (SpeechHeard) -> Void
    ) async throws {
        starts.append(locale)
        if downloads { downloading() }
        if let failure { throw failure }
        self.heard = heard
    }

    func finish() async {
        finishes += 1
        if let lastWords { heard?(lastWords) }
    }

    func cancel() async {
        cancels += 1
    }

    func say(_ text: String, final: Bool) {
        heard?(SpeechHeard(text: text, isFinal: final))
    }
}

@MainActor
final class TranscriptionModelTests: XCTestCase {
    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<200 where !condition() { await Task.yield() }
        if !condition() { XCTFail("the condition never held", file: file, line: line) }
    }

    func testListensInThePickedLanguageAndShowsWhatIsHeardAsItIsHeard() async {
        let listener = FakeListener()
        let model = TranscriptionModel(listener: listener, language: .chinese)
        XCTAssertEqual(model.phase, .preparing)
        XCTAssertFalse(model.canInsert)
        model.start()
        await until { model.phase == .listening }
        XCTAssertEqual(listener.starts.map(\.identifier), ["zh-CN"])
        listener.say("Hello", final: false)
        XCTAssertEqual(model.text, "Hello")
        listener.say("Hello there.", final: true)
        listener.say("How", final: false)
        XCTAssertEqual(model.settled, "Hello there.")
        XCTAssertEqual(model.text, "Hello there. How")
        XCTAssertTrue(model.canInsert)
    }

    func testInsertWaitsForTheLastWordsAndHandsOverAllOfIt() async {
        let listener = FakeListener()
        listener.lastWords = SpeechHeard(text: "How are you?", isFinal: true)
        let model = TranscriptionModel(listener: listener, language: .english)
        model.start()
        await until { model.phase == .listening }
        listener.say("Hello.", final: true)
        listener.say("How", final: false)
        var inserted: [String] = []
        model.finish { inserted.append($0) }
        XCTAssertEqual(model.phase, .finishing)
        XCTAssertFalse(model.canInsert, "a second Insert while finishing does nothing")
        model.finish { inserted.append($0) }
        await until { model.phase == .ended }
        XCTAssertEqual(inserted, ["Hello. How are you?"])
        XCTAssertEqual(listener.finishes, 1)
    }

    func testCancelDropsWhatIsHeardAfterIt() async {
        let listener = FakeListener()
        let model = TranscriptionModel(listener: listener, language: .english)
        model.start()
        await until { model.phase == .listening }
        model.cancel()
        listener.say("Late", final: true)
        XCTAssertEqual(model.text, "")
        XCTAssertEqual(model.phase, .ended)
        await until { listener.cancels == 1 }
    }

    func testAFailureKeepsTheWordsAndInsertsThemWithoutWaiting() async {
        let listener = FakeListener()
        let model = TranscriptionModel(listener: listener, language: .english)
        model.start()
        await until { model.phase == .listening }
        listener.say("Kept", final: false)
        listener.failure = .failed
        model.choose(.chinese)
        await until { model.phase == .stopped(.failed) }
        XCTAssertEqual(model.text, "Kept")
        var inserted: [String] = []
        model.finish { inserted.append($0) }
        XCTAssertEqual(inserted, ["Kept"])
        XCTAssertEqual(listener.finishes, 0)
    }

    func testSwitchingLanguageKeepsTheWordsAndListensAgainInTheNewOne() async {
        let listener = FakeListener()
        var remembered: [TranscriptionLanguage] = []
        let model = TranscriptionModel(listener: listener, language: .english) { remembered.append($0) }
        model.start()
        await until { model.phase == .listening }
        listener.say("Meeting notes", final: false)
        model.choose(.chinese)
        XCTAssertEqual(model.phase, .preparing)
        await until { model.phase == .listening }
        XCTAssertEqual(model.settled, "Meeting notes")
        XCTAssertEqual(listener.starts.map(\.identifier).last, "zh-CN")
        XCTAssertEqual(remembered, [.chinese])
        listener.say("\u{4F1A}\u{8BAE}", final: true)
        XCTAssertEqual(model.text, "Meeting notes\u{4F1A}\u{8BAE}")
    }

    func testShowsTheDownloadAndAMicrophoneRefusal() async {
        let listener = FakeListener()
        listener.downloads = true
        listener.failure = .microphoneDenied
        let model = TranscriptionModel(listener: listener, language: .english)
        model.start()
        await until { model.phase == .stopped(.microphoneDenied) }
        XCTAssertEqual(SpeechFailure.microphoneDenied.message, L10n.phoneTranscribeMicDenied())
        XCTAssertFalse(model.canInsert, "nothing was heard, so there is nothing to insert")
    }

    func testThePreferredLanguageIsThePickedOneElseTheAppsOwn() {
        XCTAssertEqual(TranscriptionLanguage.preferred(stored: "chinese", appLanguage: "en"), .chinese)
        XCTAssertEqual(TranscriptionLanguage.preferred(stored: nil, appLanguage: "zh-Hans"), .chinese)
        XCTAssertEqual(TranscriptionLanguage.preferred(stored: "klingon", appLanguage: "en"), .english)
        XCTAssertEqual(TranscriptionLanguage.preferred(stored: nil, appLanguage: nil), .english)
    }
}

final class TranscriptTests: XCTestCase {
    func testJoinsSpacedWordsWithASpaceAndChineseWithNone() {
        XCTAssertEqual(Transcript.join("Hello", "there"), "Hello there")
        XCTAssertEqual(Transcript.join("Hello ", "there"), "Hello there")
        XCTAssertEqual(Transcript.join("", "there"), "there")
        XCTAssertEqual(Transcript.join("\u{4F60}\u{597D}", "\u{4E16}\u{754C}"), "\u{4F60}\u{597D}\u{4E16}\u{754C}")
        XCTAssertEqual(Transcript.join("\u{3002}", "Next"), "\u{3002}Next")
    }

    func testCutsALongTranscriptAtASpaceIntoPiecesThatJoinBackWhole() {
        let text = "one two three four"
        let pieces = Transcript.chunks(text, limit: 9)
        XCTAssertEqual(pieces, ["one two ", "three ", "four"])
        XCTAssertEqual(pieces.joined(), text)
        XCTAssertEqual(Transcript.chunks("abcdefgh", limit: 3), ["abc", "def", "gh"])
        XCTAssertEqual(Transcript.chunks("", limit: 3), [])
    }
}

final class ScanEncodingTests: XCTestCase {
    func testKeepsAPageWithinTheLongestSideAndItsShape() {
        XCTAssertEqual(ScanEncoding.size(fitting: CGSize(width: 1_200, height: 1_600)), CGSize(width: 1_200, height: 1_600))
        XCTAssertEqual(ScanEncoding.size(fitting: CGSize(width: 3_024, height: 4_032)), CGSize(width: 1_800, height: 2_400))
        XCTAssertEqual(ScanEncoding.size(fitting: CGSize(width: 4_800, height: 1_200)), CGSize(width: 2_400, height: 600))
    }

    func testAPageIsAJPEGSmallEnoughForOneMessage() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let page = UIGraphicsImageRenderer(size: CGSize(width: 3_000, height: 4_000), format: format).image { context in
            Tokens.Color.phoneBackground.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 3_000, height: 4_000))
        }
        let data = try XCTUnwrap(ScanEncoding.jpeg(page))
        XCTAssertEqual(Array(data.prefix(2)), [0xFF, 0xD8])
        XCTAssertLessThan(data.base64EncodedString().utf8.count, Message.maxBytes / 2)
        let decoded = try XCTUnwrap(UIImage(data: data))
        XCTAssertLessThanOrEqual(max(decoded.size.width, decoded.size.height) * decoded.scale, ScanEncoding.longestSide)
    }

    func testNamesEachPageByItsNumber() {
        XCTAssertEqual(ScanEncoding.name(page: 2), "\(L10n.phoneCaptureScanPage(number: "2")).jpg")
    }
}
