import AppIntents
import SwiftUI
import WidgetKit

private let todayURL = URL(string: "devot://today")!

@main
struct DevotWidgets: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        TodayControl()
    }
}

struct TodayEntry: TimelineEntry {
    let date: Date
}

/// One entry a day: the widget shows only the date, so it reads nothing from the app.
struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry { TodayEntry(date: .now) }

    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        completion(TodayEntry(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        let calendar = Calendar.current
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: .now))
        completion(Timeline(entries: [TodayEntry(date: .now)], policy: tomorrow.map { .after($0) } ?? .atEnd))
    }
}

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "io.github.jma49.devot.widget.today", provider: TodayProvider()) { entry in
            TodayView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
                .widgetURL(todayURL)
        }
        .configurationDisplayName(Text("widget.today.name"))
        .description(Text("widget.today.description"))
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct TodayView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodayEntry

    private var day: Text {
        Text(entry.date, format: .dateTime.weekday(.wide).month().day())
    }

    var body: some View {
        switch family {
        case .accessoryInline:
            Label { Text("widget.today.label") } icon: { Image(systemName: "square.and.pencil") }
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "square.and.pencil").font(.title2)
            }
            .accessibilityLabel(Text("widget.today.name"))
        case .accessoryRectangular:
            VStack(alignment: .leading) {
                Label { Text("widget.today.label") } icon: { Image(systemName: "square.and.pencil") }
                    .font(.headline)
                day.font(.caption)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        default:
            VStack(alignment: .leading, spacing: 4) {
                Image(systemName: "square.and.pencil")
                    .font(.title2)
                    .foregroundStyle(.tint)
                Spacer(minLength: 0)
                Text("widget.today.label").font(.headline)
                day.font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}

struct TodayControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "io.github.jma49.devot.control.today") {
            ControlWidgetButton(action: OpenTodayFromControlIntent()) {
                Label { Text("widget.today.label") } icon: { Image(systemName: "square.and.pencil") }
            }
        }
        .displayName("widget.today.name")
        .description("widget.today.description")
    }
}

/// The Control runs its intent in this extension; the Shortcuts action of the same name lives in devot_Intents.
struct OpenTodayFromControlIntent: AppIntent {
    static let title: LocalizedStringResource = "widget.today.title"
    static let isDiscoverable = false

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(todayURL))
    }
}
