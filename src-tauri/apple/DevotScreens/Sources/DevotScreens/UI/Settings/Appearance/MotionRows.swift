import SwiftUI

/// Always, Follow System and Off as checkmark rows in place; the check moves at once.
struct MotionRows: View {
    let store: SettingsStore
    @ScaledMetric(relativeTo: .body) private var check: CGFloat = 18

    static let choices = ["always", "system", "off"]

    var body: some View {
        let current = MotionPolicy(editor: store.editor).choice.rawValue
        Section {
            ForEach(Self.choices, id: \.self) { choice in
                Button {
                    store.setEditor("animations", .string(choice))
                } label: {
                    HStack {
                        Text(catalog("appearanceSettings.animations.\(choice)")).settingsLabel()
                        Spacer(minLength: Tokens.Size.phoneGroupedGap)
                        if choice == current {
                            Image(systemName: "checkmark")
                                .font(.system(size: check, weight: .semibold))
                                .foregroundStyle(Color(Tokens.Color.accentText))
                                .accessibilityHidden(true)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(choice == current ? .isSelected : [])
                .settingsRow()
            }
        } header: {
            Header(catalog("appearanceSettings.groupMotion"))
        } footer: {
            Footer(L10n.phoneSettingsAppearanceAnimationsFooter())
        }
        .sensoryFeedback(.selection, trigger: current)
    }
}
