import UIKit
import XCTest

@testable import DevotScreens

/// A note row as VoiceOver and UI tests see it: a button that opens the note, not an image, its status and pin in its value.
@MainActor
final class NoteCellTests: XCTestCase {
    func testARowReadsAsARowWithItsStatusAndPinInItsValue() {
        let note = NoteRow(
            id: "01970000-0000-7000-8000-000000000001", title: "Plans", createdAt: 0, updatedAt: 0, bookId: nil,
            status: NoteStatus.active.rawValue, pinned: true, tagIds: [], bodyVersion: 1)
        let cell = NoteCell(frame: CGRect(x: 0, y: 0, width: 390, height: 64))
        cell.show(NoteCell.Row(note: note, excerpt: "First line", tag: nil, now: Date(), reduceMotion: true))
        cell.layoutIfNeeded()
        XCTAssertEqual(cell.accessibilityTraits, .button, "a row opens its note")
        XCTAssertEqual(cell.accessibilityValue, [NoteStatus.active.name, L10n.sidebarPinned()].joined(separator: ", "))
    }
}
