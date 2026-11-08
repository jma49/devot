import SwiftUI

struct Choice: Hashable {
    let value: JSONValue
    let title: String
    var depth = 0
}

/// A choice's own page: one checkmark row per legal value, the chosen one ticked.
struct ChoicePage: View {
    let store: SettingsStore
    let choices: [Choice]
    var footer: String?
    let selected: () -> JSONValue?
    let choose: (JSONValue) -> Void

    var body: some View {
        let current = selected()
        Form {
            Section {
                ForEach(choices, id: \.self) { choice in
                    Button {
                        choose(choice.value)
                    } label: {
                        HStack {
                            Text(choice.title).settingsLabel()
                                .padding(.leading, CGFloat(choice.depth) * Tokens.Size.phoneGroupedPadX)
                            Spacer(minLength: Tokens.Size.phoneGroupedGap)
                            if choice.value == current {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 18, weight: .semibold))
                                    .foregroundStyle(Color(Tokens.Color.accentText))
                                    .accessibilityHidden(true)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(choice.value == current ? .isSelected : [])
                    .settingsRow()
                }
            } footer: {
                if let footer { Footer(footer) }
            }
        }
        .settingsPage(store)
        .sensoryFeedback(.selection, trigger: current)
    }
}

extension Array where Element == Choice {
    /// The legal values, with the stored one kept in order when it is not among them.
    static func numbers(_ values: [Double], stored: Double?, format: (Double) -> String) -> [Choice] {
        var all = values
        if let stored, !all.contains(stored) { all = (all + [stored]).sorted() }
        return all.map { Choice(value: .number($0), title: format($0)) }
    }
}
