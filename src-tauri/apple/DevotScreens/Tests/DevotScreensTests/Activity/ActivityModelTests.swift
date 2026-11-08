import XCTest

@testable import DevotScreens

/// `activity.writing` as the Activity tab reads it (docs/specs/iphone-screens.md, Activity).
final class ActivityModelTests: XCTestCase {
    /// Sunday 2026-11-08: the grid starts on the Monday fourteen weeks before that week's.
    private let today = 20765
    private let first = 20661

    private func answer(days: [JSONValue], ranked: [JSONValue] = []) -> JSONValue {
        let week: (Int) -> JSONValue = { words in
            .object([
                "words": .number(Double(words)), "streak": .number(2), "notesEdited": .number(3),
                "ranked": .array(ranked),
            ])
        }
        return .object([
            "first": .number(Double(first)), "today": .number(Double(today)), "days": .array(days),
            "weeks": .object(["this": week(40), "last": week(7)]),
        ])
    }

    private func day(_ day: Int, words: Int, level: Int) -> JSONValue {
        .object(["day": .number(Double(day)), "words": .number(Double(words)), "level": .number(Double(level))])
    }

    func testReadsTheWeeksFiguresAndTheRankedNotesItCanName() throws {
        let ranked: [JSONValue] = [
            .object(["id": .string("a"), "title": .string("Big"), "words": .number(30)]),
            .object(["id": .string("b"), "words": .number(9)]),
        ]
        let writing = try XCTUnwrap(ActivityWriting(answer(days: [day(today, words: 40, level: 4)], ranked: ranked)))
        XCTAssertEqual(writing.week(.this).words, 40)
        XCTAssertEqual(writing.week(.last).words, 7)
        XCTAssertEqual(writing.week(.this).ranked, [ActivityWriting.Ranked(id: "a", title: "Big", words: 30)])
        XCTAssertEqual(writing.totalWords, 40)
        XCTAssertEqual(writing.activeDays, 1)
    }

    func testRefusesDaysOutsideTheSpanOrPastTheDarkestShade() {
        XCTAssertNil(ActivityWriting(answer(days: [day(today + 1, words: 1, level: 1)])))
        XCTAssertNil(ActivityWriting(answer(days: [day(first - 1, words: 1, level: 1)])))
        XCTAssertNil(ActivityWriting(answer(days: [day(today, words: 1, level: 5)])))
        XCTAssertNil(ActivityWriting(answer(days: [day(today, words: 1, level: 1)]).object.map { fields in
            var fields = fields
            fields["first"] = .number(Double(today - ActivityWriting.weeks * 7))
            return .object(fields)
        } ?? .null))
    }

    func testTheGridIsAColumnAWeekFromMondayWithNoCellsAfterToday() throws {
        let writing = try XCTUnwrap(
            ActivityWriting(answer(days: [day(first, words: 5, level: 2), day(today, words: 9, level: 3)])))
        let grid = writing.grid
        XCTAssertEqual(grid.count, ActivityWriting.weeks)
        XCTAssertTrue(grid.allSatisfy { $0.count == 7 })
        XCTAssertEqual(grid[0][0], 2, "the first Monday")
        XCTAssertEqual(grid[0][1], 0, "a day without writing")
        XCTAssertEqual(grid[ActivityWriting.weeks - 1][6], 3, "today, a Sunday, ends the last column")
        XCTAssertEqual(ActivityWriting.weekday(today), 6)
    }

    func testDaysAfterTodayAreLeftEmpty() throws {
        let tuesday = today - 5
        var fields = try XCTUnwrap(answer(days: []).object)
        fields["today"] = .number(Double(tuesday))
        let writing = try XCTUnwrap(ActivityWriting(.object(fields)))
        XCTAssertEqual(writing.grid[ActivityWriting.weeks - 1].map { $0 == nil }, [false, false, true, true, true, true, true])
    }

    /// The same names `monthLabels` (src/renderer/src/activityMonths.ts) gives in en-US.
    func testNamesTheMonthsAsThePageDid() {
        let english = Locale(identifier: "en_US")
        XCTAssertEqual(
            ActivityWriting.monthLabels(first: first, weeks: 15, locale: english),
            ["", "Aug", "", "", "", "", "Sep", "", "", "", "Oct", "", "", "", "Nov"])
        XCTAssertEqual(
            ActivityWriting.monthLabels(first: 20486, weeks: 15, locale: english),
            ["Feb", "", "", "", "Mar", "", "", "", "", "Apr", "", "", "", "May", ""])
    }
}
