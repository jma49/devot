import UIKit
import XCTest

@testable import DevotScreens

/// The native Activity tab in a window: it reads its figures, switches weeks at once and opens a
/// ranked note as a list's row does.
@MainActor
final class ActivityScreenTests: XCTestCase {
    private var window: UIWindow?
    private var bridge: FakeBridge!
    private var context: ListContext!
    private var opened: [String] = []

    override func setUp() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        bridge = FakeBridge()
        context = ListContext()
        context.bridge = bridge
        opened = []
        context.open = { [unowned self] id, _ in opened.append(id) }
    }

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
    }

    private func shown() -> ActivityScreen {
        let screen = ActivityScreen(context: context)
        let navigation = UINavigationController(rootViewController: screen)
        window?.rootViewController = navigation
        window?.makeKeyAndVisible()
        navigation.view.layoutIfNeeded()
        return screen
    }

    private func week(_ ranked: [(String, String, Int)]) -> JSONValue {
        .object([
            "words": .number(12), "streak": .number(1), "notesEdited": .number(Double(ranked.count)),
            "ranked": .array(ranked.map { .object(["id": .string($0.0), "title": .string($0.1), "words": .number(Double($0.2))]) }),
        ])
    }

    private func answer(this: [(String, String, Int)], last: [(String, String, Int)] = []) -> Outcome {
        .ok(.object([
            "first": .number(20661), "today": .number(20765), "days": .array([]),
            "weeks": .object(["this": week(this), "last": week(last)]),
        ]))
    }

    private func rows(_ screen: ActivityScreen) -> [String] {
        let count = screen.collection.numberOfItems(inSection: ActivityScreen.Section.ranked.rawValue)
        return (0..<count).compactMap { item in
            let path = IndexPath(item: item, section: ActivityScreen.Section.ranked.rawValue)
            screen.collection.layoutIfNeeded()
            let cell = screen.collection.cellForItem(at: path) as? UICollectionViewListCell
            return (cell?.contentConfiguration as? UIListContentConfiguration)?.text
        }
    }

    func testReadsItsFiguresOnceShownAndListsTheWeeksMostEditedNotes() {
        let screen = shown()
        XCTAssertEqual(bridge.ops, [Op.activityWriting.rawValue])
        bridge.answer(Op.activityWriting.rawValue, answer(this: [("a", "Plan", 30), ("b", "", 4)]))
        XCTAssertEqual(rows(screen), ["Plan", L10n.noteUntitled()])
        XCTAssertEqual(screen.navigationItem.title, L10n.phoneTabActivity())
    }

    func testAnotherWeekReplacesTheRankedNotesAtOnce() {
        let screen = shown()
        bridge.answer(Op.activityWriting.rawValue, answer(this: [("a", "Plan", 30)], last: []))
        screen.choose(.last)
        XCTAssertEqual(screen.period, .last)
        XCTAssertEqual(rows(screen), [L10n.phoneActivityNoGrowth()])
        XCTAssertTrue(bridge.sent.isEmpty, "the week's figures came with the first reading")
    }

    private func cell<Cell: UICollectionViewCell>(_ section: ActivityScreen.Section) -> (ActivityScreen) -> Cell? {
        { screen in
            screen.collection.layoutIfNeeded()
            return screen.collection.cellForItem(at: IndexPath(item: 0, section: section.rawValue)) as? Cell
        }
    }

    func testTheFiguresFollowTheChosenWeekAndTheHeatmapReadsAsOneSummary() throws {
        let screen = shown()
        bridge.answer(Op.activityWriting.rawValue, answer(this: [("a", "Plan", 30)]))
        let figures: FiguresCell = try XCTUnwrap(cell(.figures)(screen))
        XCTAssertEqual(figures.period.selectedSegmentIndex, 0)
        XCTAssertEqual(figures.values.map(\.text), ["12", "1", "1"])
        XCTAssertEqual(figures.captions.first?.text, L10n.phoneActivityWordsThis())
        XCTAssertTrue(figures.values.allSatisfy(\.adjustsFontForContentSizeCategory))
        figures.period.selectedSegmentIndex = 1
        figures.period.sendActions(for: .valueChanged)
        XCTAssertEqual(screen.period, .last)
        let shownAfter: FiguresCell = try XCTUnwrap(cell(.figures)(screen))
        XCTAssertEqual(shownAfter.values.map(\.text), ["12", "1", "0"])
        XCTAssertEqual(shownAfter.captions.first?.text, L10n.phoneActivityWordsLast())
        let heatmap: HeatmapCell = try XCTUnwrap(cell(.heatmap)(screen))
        XCTAssertTrue(heatmap.grid.isAccessibilityElement)
        XCTAssertEqual(
            heatmap.grid.accessibilityLabel,
            L10n.phoneActivitySummary(weeks: "15", words: "0", days: "0"))
    }

    /// The labels Devot sizes; the system's segmented control keeps its own size, as the accessibility audit expects.
    private func labels(in view: UIView) -> [UILabel] {
        view.subviews.flatMap { subview -> [UILabel] in
            if subview is UISegmentedControl { return [] }
            return (subview as? UILabel).map { [$0] } ?? labels(in: subview)
        }
    }

    func testEveryLineGrowsWithTheTextSizeAndKeepsItsRoom() throws {
        let screen = shown()
        bridge.answer(Op.activityWriting.rawValue, answer(this: [("a", "Plan", 30)]))
        let before: [String: CGFloat] = try [ActivityScreen.Section.heatmap, .figures].reduce(into: [:]) { sizes, section in
            let shown: UICollectionViewCell = try XCTUnwrap(cell(section)(screen))
            for label in labels(in: shown.contentView) where label.text?.isEmpty == false {
                sizes[label.text ?? ""] = label.font.pointSize
            }
        }
        screen.navigationController?.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        screen.navigationController?.view.layoutIfNeeded()
        screen.collection.layoutIfNeeded()
        for section in [ActivityScreen.Section.heatmap, .figures] {
            let shown: UICollectionViewCell = try XCTUnwrap(cell(section)(screen))
            for label in labels(in: shown.contentView) where label.text?.isEmpty == false && !label.isHidden {
                let text = label.text ?? ""
                XCTAssertGreaterThan(label.font.pointSize, before[text] ?? .infinity, text)
                XCTAssertGreaterThanOrEqual(label.bounds.height + 0.5, label.font.lineHeight, text)
                if [L10n.phoneActivityLess(), L10n.phoneActivityMore()].contains(text) {
                    XCTAssertLessThan(label.bounds.height, 1.5 * label.font.lineHeight, "\(text) keeps to one line")
                }
                let frame = label.convert(label.bounds, to: shown)
                XCTAssertTrue(shown.bounds.insetBy(dx: -0.5, dy: -0.5).contains(frame), "\(text) \(frame) in \(shown.bounds)")
            }
        }
        let grid = try XCTUnwrap((cell(.heatmap)(screen) as HeatmapCell?)?.grid)
        let months = grid.monthFrames.filter { !$0.isNull }
        XCTAssertFalse(months.isEmpty)
        XCTAssertTrue(months.allSatisfy { grid.bounds.insetBy(dx: -0.5, dy: -0.5).contains($0) }, "\(months) in \(grid.bounds)")
    }

    func testARankedNoteOpensAndTheEmptyRowDoesNot() {
        let screen = shown()
        bridge.answer(Op.activityWriting.rawValue, answer(this: [("a", "Plan", 30)]))
        let section = ActivityScreen.Section.ranked.rawValue
        let first = IndexPath(item: 0, section: section)
        XCTAssertEqual(screen.collectionView(screen.collection, shouldSelectItemAt: first), true)
        screen.collectionView(screen.collection, didSelectItemAt: first)
        XCTAssertEqual(opened, ["a"])
        screen.choose(.last)
        XCTAssertEqual(screen.collectionView(screen.collection, shouldSelectItemAt: first), false)
    }

    func testAChangedNoteReadsTheFiguresAgainAndAFailureIsLoggedByCode() {
        let screen = shown()
        bridge.answer(Op.activityWriting.rawValue, .failed("E_SCREENS_UNAVAILABLE"))
        XCTAssertTrue(bridge.lines.contains("W_PHONE_ACTIVITY_READ_FAILED code=E_SCREENS_UNAVAILABLE"))
        context.notesChanged(rev: 2, ids: ["a"], all: false)
        XCTAssertEqual(bridge.ops.filter { $0 == Op.activityWriting.rawValue }.count, 1)
        _ = screen
    }
}
