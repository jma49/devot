import UIKit
import XCTest

@testable import DevotScreens

/// Records what a feedback generator is asked, in order, as `kind.prepare` and `kind.occurred`.
@MainActor
final class HapticRecorder {
    private(set) var log: [String] = []
    private(set) var made: [HapticKind] = []

    private struct Generator: HapticGenerator {
        let kind: HapticKind
        let recorder: HapticRecorder

        func prepare() { recorder.log.append("\(kind).prepare") }
        func occurred() { recorder.log.append("\(kind).occurred") }
    }

    func make(_ kind: HapticKind) -> any HapticGenerator {
        made.append(kind)
        return Generator(kind: kind, recorder: self)
    }

    func clear() { log = [] }
}

/// design/motion.md, Haptics: which generator plays for which event, and that each is made ready
/// before it fires.
@MainActor
final class HapticsTests: XCTestCase {
    private let recorder = HapticRecorder()
    private lazy var haptics = Haptics(make: recorder.make)

    private let table: [(HapticEvent, HapticKind)] = [
        (.statusChange, .selection), (.pickerChoice, .selection), (.tabReselect, .selection),
        (.pinToggled, .light), (.listAction, .light), (.undoableTrash, .light),
        (.gateSheet, .warning), (.purchaseRestored, .success), (.purchaseFailed, .error),
    ]

    func testEveryEventPlaysItsOwnGeneratorAfterPreparingIt() {
        XCTAssertEqual(Set(table.map(\.0)), Set(HapticEvent.allCases), "the table names every event")
        for (event, kind) in table {
            recorder.clear()
            haptics.play(event)
            XCTAssertEqual(recorder.log, ["\(kind).prepare", "\(kind).occurred"], "\(event)")
        }
    }

    func testATouchDownPreparesAndFiresNothing() {
        haptics.prepare(.pinToggled)
        XCTAssertEqual(recorder.log, ["light.prepare"])
        haptics.play(.pinToggled)
        XCTAssertEqual(recorder.log.last, "light.occurred")
        XCTAssertEqual(recorder.log.firstIndex(of: "light.prepare"), 0)
    }

    func testAGeneratorIsMadeOnceForTheSessionAndSharedByEventsOfOneKind() {
        for event in [HapticEvent.pinToggled, .listAction, .undoableTrash, .pinToggled] { haptics.play(event) }
        haptics.play(.statusChange)
        haptics.prepare(.tabReselect)
        XCTAssertEqual(recorder.made, [.light, .selection])
    }

    func testAWriteMapsToTheHapticItDeservesOrNone() {
        let expected: [(NoteChange, HapticEvent?)] = [
            (.pinned(true), .pinToggled), (.pinned(false), .pinToggled), (.status(.completed), .statusChange),
            (.trash, .undoableTrash), (.book("b"), .listAction), (.book(nil), .listAction), (.putTag("t"), .listAction),
            (.removeTag("t"), .listAction), (.restore, .listAction), (.purge, nil),
        ]
        for (change, event) in expected {
            XCTAssertEqual(HapticEvent(change), event, "\(change)")
        }
    }

    func testTheSilentDefaultMakesNoSound() {
        let silent = Haptics()
        silent.prepare(.gateSheet)
        silent.play(.gateSheet)
    }

    func testSystemGeneratorsAreTheUIKitOnesAnchoredToTheView() throws {
        let view = UIView()
        let make = Haptics.system(view: view)
        let kinds: [(HapticKind, AnyClass)] = [
            (.selection, UISelectionFeedbackGenerator.self), (.light, UIImpactFeedbackGenerator.self),
            (.warning, UINotificationFeedbackGenerator.self), (.success, UINotificationFeedbackGenerator.self),
            (.error, UINotificationFeedbackGenerator.self),
        ]
        XCTAssertEqual(Set(kinds.map(\.0)), Set(HapticKind.allCases))
        for (kind, type) in kinds {
            let generator = try XCTUnwrap(make(kind) as? SystemHaptic, "\(kind)")
            XCTAssertTrue(generator.feedback.isKind(of: type), "\(kind)")
            XCTAssertTrue(generator.feedback.view === view, "\(kind)")
        }
    }
}
