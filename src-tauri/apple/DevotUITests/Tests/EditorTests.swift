import DevotScreens
import XCTest

/// A note pushed from its row in the native Notes list of the installed app: its cover, the back swipe, a link to
/// another note, and the welcome example's diagrams and math drawn on the device.
@MainActor
final class EditorTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "io.github.jma49.devot")
        app.launch()
        // A cold debug build starts slowly on a CI simulator.
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 120))
    }

    private var page: XCUIElement { app.webViews.firstMatch }
    private var tabBar: XCUIElement { app.tabBars.firstMatch }
    /// The note's own bar, told from a list's by its Info button.
    private var noteBar: XCUIElement {
        app.navigationBars.containing(NSPredicate(format: "label == %@", L10n.phoneInfoTitle())).firstMatch
    }
    /// A note hides the tab bar, which may then be gone from the tree, where `isHittable` would fail.
    private var tabBarShown: Bool { tabBar.exists && tabBar.isHittable }

    private func waitUntil(_ condition: () -> Bool, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return condition()
    }

    /// A slow drag from 2 pt inside the left edge, where only the system's back swipe starts. On a
    /// loaded simulator UIKit turns back most fast synthesized drags even in an app of plain view
    /// controllers, and keeps every slow one.
    private func edgeSwipe(by distance: CGFloat) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
            .withOffset(CGVector(dx: 2, dy: 0))
        start.press(
            forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: distance, dy: 0)),
            withVelocity: .slow, thenHoldForDuration: 0.2)
    }

    /// The screen at a step, kept with the result bundle of a run that passes too.
    private func keepScreen(_ step: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = step
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func scrollUntil(_ found: () -> Bool, swipes: Int = 30) -> Bool {
        for _ in 0..<swipes where !found() {
            page.swipeUp(velocity: .slow)
        }
        return found()
    }

    /// The app starts on Library; the Notes tab's native list has every note, a row a cell whose
    /// label holds its title and second line.
    private func openExample() {
        let notes = tabBar.buttons[L10n.phoneTabNotes()]
        XCTAssertTrue(notes.waitForExistence(timeout: 10))
        notes.tap()
        let row = app.collectionViews.cells.containing(
            NSPredicate(format: "label == %@", L10n.welcomeExampleTitle())
        ).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "the welcome example is listed")
        XCTAssertTrue(waitUntil { row.isHittable }, "the welcome example's row is on screen")
        keepScreen("the Notes list")
        row.tap()
        let pushed = noteBar.waitForExistence(timeout: 10)
        keepScreen("the row tapped")
        XCTAssertTrue(pushed, "the row pushes its note")
        XCTAssertTrue(app.otherElements["editor.cover"].waitForNonExistence(timeout: 5), "the cover fades")
        XCTAssertTrue(waitUntil { !tabBarShown }, "the note hides the tab bar")
        keepScreen("the example open")
    }

    func testANoteSlidesInAndTheBackSwipeTakesItAwayOrTurnsBack() throws {
        openExample()

        edgeSwipe(by: 60)
        keepScreen("a short swipe")
        XCTAssertTrue(noteBar.waitForExistence(timeout: 5), "a swipe turned back keeps the note")
        XCTAssertFalse(tabBarShown)

        edgeSwipe(by: app.frame.width * 0.8)
        let listShown = waitUntil { tabBarShown }
        keepScreen("a full swipe")
        XCTAssertTrue(listShown, "a full swipe brings the list and its tab bar back")
        XCTAssertTrue(noteBar.waitForNonExistence(timeout: 5))

        openExample()
    }

    func testALinkPushesTheLinkedNoteAndBackReturnsToTheFirst() throws {
        openExample()
        let link = page.links[L10n.welcomeTitle()].firstMatch
        XCTAssertTrue(scrollUntil { link.exists && link.isHittable })
        link.tap()
        let replaced = link.waitForNonExistence(timeout: 10)
        keepScreen("the link followed")
        XCTAssertTrue(replaced, "the welcome note replaced the example")
        XCTAssertTrue(noteBar.exists)

        edgeSwipe(by: app.frame.width * 0.8)
        let back = link.waitForExistence(timeout: 10)
        keepScreen("a full swipe on the linked note")
        XCTAssertTrue(back, "back on the example")
        XCTAssertTrue(noteBar.exists)
        XCTAssertFalse(tabBarShown)
    }

    /// Keeps the web view's tree with a failing run, and prints the part from `marker` on, since
    /// the CI log keeps only lines that start with "Evidence:".
    private func keepTree(from marker: String) {
        let tree = page.debugDescription
        let attachment = XCTAttachment(string: tree)
        attachment.name = "web view tree"
        attachment.lifetime = .keepAlways
        add(attachment)
        let lines = tree.split(separator: "\n")
        let start = lines.firstIndex { $0.contains(marker) } ?? 0
        for line in lines[start..<min(start + 60, lines.count)] {
            print("Evidence: \(line)")
        }
    }

    private func flattened(_ node: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
        [node] + node.children.flatMap(flattened)
    }

    /// The elements from `node` down to the first one `match` accepts.
    private func path(
        in node: XCUIElementSnapshot, to match: (XCUIElementSnapshot) -> Bool
    ) -> [XCUIElementSnapshot] {
        if match(node) { return [node] }
        for child in node.children {
            let rest = path(in: child, to: match)
            if !rest.isEmpty { return [node] + rest }
        }
        return []
    }

    func testTheExampleDrawsEveryDiagramAndFormula() throws {
        openExample()

        // The example's Math section comes before its Diagrams; the formulas follow this sentence.
        let sentence = "Inline math sits in a sentence, like"
        let math = page.staticTexts[sentence]
        let reached = scrollUntil { math.exists && math.isHittable }
        // WebKit hands each drawn <math> to accessibility as one element without a label (VoiceOver
        // reads it through the math API), so a formula is a bare leaf where TeX would be text.
        func isFormula(_ node: XCUIElementSnapshot) -> Bool {
            node.elementType == .other && node.label.isEmpty && node.children.isEmpty && !node.frame.isEmpty
        }
        let tree = try page.snapshot()
        let found = path(in: tree) { $0.elementType == .staticText && $0.label == sentence }
        let paragraph = found.count >= 3 ? found[found.count - 2] : nil
        let body = found.count >= 3 ? found[found.count - 3].children : []
        let inline = paragraph?.children.filter(isFormula) ?? []
        // The note's blocks between the sentence's paragraph and the Diagrams heading.
        let after = body.firstIndex { $0 as AnyObject === paragraph as AnyObject }
            .map { $0 + 1 } ?? body.endIndex
        let display = Array(body[after...].prefix { $0.label != "Diagrams" })
        let nodes = flattened(tree)
        func shown(_ text: String) -> Int {
            nodes.filter { $0.label.contains(text) }.count
        }
        let tex = shown("\\int") + shown("mc^2") + shown("$E")
        let drawn = inline.count == 1 && display.count == 1 && display.allSatisfy(isFormula)
        if !reached || !drawn || tex > 0 { keepTree(from: sentence) }
        XCTAssertTrue(reached, "the Math section is on screen")
        XCTAssertEqual(inline.count, 1, "the inline formula is drawn in its sentence")
        XCTAssertEqual(display.count, 1, "one block between the sentence and the Diagrams heading")
        XCTAssertTrue(display.allSatisfy(isFormula), "the display formula is drawn on its own line")
        XCTAssertEqual(shown("\\int"), 0, "no display formula left as TeX")
        XCTAssertEqual(shown("mc^2"), 0, "no inline formula left as TeX")
        XCTAssertEqual(shown("$E"), 0, "no inline formula left between dollar signs")

        let diagrams = page.images.matching(NSPredicate(format: "label BEGINSWITH %@", L10n.mermaidLabel()))
        // Mermaid, PlantUML and Markmap in the example's Diagrams section.
        XCTAssertTrue(scrollUntil { diagrams.count >= 3 }, "found \(diagrams.count) diagrams")
        XCTAssertEqual(diagrams.count, 3)
    }
}
