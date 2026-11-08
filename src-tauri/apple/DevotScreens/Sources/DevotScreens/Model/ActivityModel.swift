import Foundation

/// The Activity tab's figures as `activity.writing` answers them (docs/specs/iphone-screens.md,
/// Activity). Days are numbered as the core numbers them: whole UTC days since 1970, the person's
/// own calendar day already applied.
struct ActivityWriting: Equatable, Sendable {
    struct Day: Equatable, Sendable {
        let day: Int
        let words: Int
        let level: Int
    }

    struct Ranked: Equatable, Sendable, Hashable {
        let id: String
        let title: String
        let words: Int
    }

    struct Week: Equatable, Sendable {
        let words: Int
        let streak: Int
        let notesEdited: Int
        let ranked: [Ranked]
    }

    enum Period: String, CaseIterable, Sendable {
        case this
        case last
    }

    /// The weeks the heatmap spans (`WRITING_WEEKS` in src/core/activity.ts).
    static let weeks = 15
    /// The darkest shade (`ACTIVITY_LEVELS`).
    static let levels = 4

    let first: Int
    let today: Int
    let days: [Day]
    let this: Week
    let last: Week

    func week(_ period: Period) -> Week { period == .this ? this : last }

    init(first: Int, today: Int, days: [Day], this: Week, last: Week) {
        self.first = first
        self.today = today
        self.days = days
        self.this = this
        self.last = last
    }

    init?(_ value: JSONValue) {
        guard let first = Self.whole(value["first"]), let today = Self.whole(value["today"]), first <= today,
            today - first < Self.weeks * 7, let rows = value["days"]?.array,
            let this = Self.week(value["weeks"]?["this"]), let last = Self.week(value["weeks"]?["last"])
        else { return nil }
        var days: [Day] = []
        for row in rows {
            guard let day = Self.whole(row["day"]), let words = Self.whole(row["words"]),
                let level = Self.whole(row["level"]), (first...today).contains(day), (0...Self.levels).contains(level)
            else { return nil }
            days.append(Day(day: day, words: words, level: level))
        }
        self.init(first: first, today: today, days: days, this: this, last: last)
    }

    private static func whole(_ value: JSONValue?) -> Int? {
        guard let number = value?.number, number.isFinite, number.rounded(.towardZero) == number,
            abs(number) < 1e12
        else { return nil }
        return Int(number)
    }

    private static func week(_ value: JSONValue?) -> Week? {
        guard let value, let words = whole(value["words"]), let streak = whole(value["streak"]),
            let edited = whole(value["notesEdited"]), let rows = value["ranked"]?.array
        else { return nil }
        let ranked = rows.compactMap { row -> Ranked? in
            guard let id = row["id"]?.string, let title = row["title"]?.string, let words = whole(row["words"]) else {
                return nil
            }
            return Ranked(id: id, title: title, words: words)
        }
        return Week(words: words, streak: streak, notesEdited: edited, ranked: ranked)
    }

    /// Monday-first weekday, 0 to 6, as `weekday` in src/core/activity.ts.
    static func weekday(_ day: Int) -> Int { ((day + 3) % 7 + 7) % 7 }

    /// The level of each cell, by week (column) and weekday (row); days after today are nil.
    var grid: [[Int?]] {
        let start = today - Self.weekday(today) - (Self.weeks - 1) * 7
        let levels = Dictionary(days.map { ($0.day, $0.level) }, uniquingKeysWith: { _, last in last })
        return (0..<Self.weeks).map { week in
            (0..<7).map { row in
                let day = start + week * 7 + row
                return day > today ? nil : levels[day] ?? 0
            }
        }
    }

    var totalWords: Int { days.reduce(0) { $0 + $1.words } }
    var activeDays: Int { days.filter { $0.level > 0 }.count }

    /// Month names over the weeks where a month starts; the first week is named unless the next
    /// name is close (`monthLabels` in src/renderer/src/activityMonths.ts).
    static func monthLabels(first: Int, weeks: Int, locale: Locale = .current) -> [String] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let date = { (day: Int) in Date(timeIntervalSince1970: TimeInterval(day) * 86_400) }
        let month = { (week: Int) in calendar.component(.month, from: date(first + week * 7)) }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate("MMM")
        var labels = (0..<weeks).map { week in
            week > 0 && month(week) != month(week - 1) ? formatter.string(from: date(first + week * 7)) : ""
        }
        if weeks > 0, labels.dropFirst().prefix(2).allSatisfy(\.isEmpty) {
            labels[0] = formatter.string(from: date(first))
        }
        return labels
    }
}
