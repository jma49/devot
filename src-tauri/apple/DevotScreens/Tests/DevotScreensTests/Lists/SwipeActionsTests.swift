import UIKit
import XCTest

@testable import DevotScreens

/// A row's swipe actions, each through the gate (docs/specs/iphone-screens.md, The gate).
@MainActor
final class SwipeActionsTests: XCTestCase {
    private var licence: Licence?
    private var events: [String] = []
    private var performed: [WriteIntent] = []

    private let locked = Licence(gated: true, state: "none", trial: Licence.Trial(state: "ended", endsAt: 1000, code: nil))
    private let row = noteRow(1, updated: 1, status: "active")

    override func setUp() async throws {
        licence = nil
        events = []
        performed = []
    }

    private func actions() -> SwipeActions {
        let gate = ProGate { [unowned self] in licence }
        gate.present = { [unowned self] _ in events.append("present") }
        gate.perform = { [unowned self] in
            events.append("perform")
            performed.append($0)
        }
        return SwipeActions(gate: gate)
    }

    private func run(_ action: UIContextualAction) {
        action.handler(action, UIView()) { [unowned self] done in events.append("completion(\(done))") }
    }

    func testTrashIsAFullDestructiveSwipeAndStatusSitsBesideIt() throws {
        let trailing = actions().trailing(row)
        XCTAssertTrue(trailing.performsFirstActionWithFullSwipe)
        XCTAssertEqual(trailing.actions.map(\.style), [.destructive, .normal])
        XCTAssertEqual(trailing.actions.map(\.title), [L10n.phoneActionTrash(), L10n.phoneActionComplete()])
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            XCTAssertEqual(
                trailing.actions.map { $0.backgroundColor.resolvedColor(with: traits) },
                [Tokens.Color.phoneActionTrash, Tokens.Color.phoneActionStatus].map { $0.resolvedColor(with: traits) })
        }
        XCTAssertNotNil(trailing.actions.first?.image)
    }

    func testACompletedNoteOffersNoStatusSwipe() {
        XCTAssertEqual(actions().trailing(noteRow(1, updated: 1, status: "completed")).actions.count, 1)
    }

    func testPinLeadsAndBecomesUnpinOnAPinnedNote() {
        let leading = actions().leading(row)
        XCTAssertEqual(leading.actions.map(\.title), [L10n.phoneActionPin()])
        XCTAssertEqual(
            leading.actions.first?.backgroundColor.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)),
            Tokens.Color.phoneActionPin.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)))
        XCTAssertEqual(actions().leading(noteRow(1, updated: 1, pinned: true)).actions.map(\.title), [L10n.noteUnpin()])
    }

    func testLockedTheRowClosesFirstAndThenTheGateShowsItsSurface() throws {
        licence = locked
        let actions = actions()
        for action in actions.trailing(row).actions + actions.leading(row).actions {
            events = []
            run(action)
            XCTAssertEqual(events, ["completion(false)", "present"], action.title ?? "")
            actions.gate.dismissed()
        }
        XCTAssertEqual(performed, [])
    }

    func testUnlockedEachActionWritesThroughTheGate() throws {
        let actions = actions()
        for action in actions.trailing(row).actions + actions.leading(row).actions { run(action) }
        XCTAssertEqual(
            performed,
            [
                .batch(ids: [row.id], change: .trash), .batch(ids: [row.id], change: .status(.completed)),
                .batch(ids: [row.id], change: .pinned(true)),
            ])
        XCTAssertEqual(events.filter { $0.hasPrefix("completion") }, Array(repeating: "completion(true)", count: 3))
    }
}
