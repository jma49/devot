import SwiftUI

/// Editing: the page's phone rows (`EditingSection.tsx`) but Show Counts, each choice on its own page.
struct EditingPane: View {
    let store: SettingsStore
    let router: SettingsRouter

    var body: some View {
        Form {
            Section(catalog("editorSettings.interface")) {
                flag("toolbar")
                flag("lineNumbers")
                flag("highlightActiveLine")
                choice("lineWrapping", Self.wrapping)
                flag("inlineImages")
                flag("readableWidth", disabled: store.editor["lineWrapping"]?.string == "off")
                flag("scrollPastEnd")
                choice("cursorScrollMargin", numbers("cursorScrollMargin", Self.margins, whole))
            }
            Section(catalog("editorSettings.markdown")) {
                choice("listMarker", Self.markers)
                choice("indentUnit", Self.indents)
                choice("tabWidth", numbers("tabWidth", [2, 4, 8], whole))
                choice("pasteUrl", Self.pasteUrl)
                flag("spellCheck")
            }
            Section {
                choice("fontWeight", Self.weights)
                choice("lineHeight", numbers("lineHeight", [1.2, 1.4, 1.5, 1.6, 1.8, 2], decimal))
                flag("showInvisibles")
                flag("highlightTrailingWhitespace")
            } header: {
                Text(catalog("editorSettings.textAppearance"))
            } footer: {
                Footer(L10n.editorSettingsDetail())
            }
        }
        .settingsPage(store)
    }

    static let wrapping = ["off", "all", "prose", "unwrapAtCursor"].map {
        Choice(value: .string($0), title: catalog("editorSettings.lineWrapping.\($0)"))
    }
    static let markers = [("-", "dash"), ("*", "star"), ("+", "plus")].map {
        Choice(value: .string($0.0), title: catalog("editorSettings.marker.\($0.1)"))
    }
    static let indents = ["spaces2", "spaces4", "tab"].map {
        Choice(value: .string($0), title: catalog("editorSettings.indent.\($0)"))
    }
    static let pasteUrl = ["plain", "autolink", "link", "choose"].map {
        Choice(value: .string($0), title: catalog("editorSettings.pasteUrl.\($0)"))
    }
    static let weights = ["normal", "300", "400", "500", "600", "700"].map {
        Choice(value: .string($0), title: $0 == "normal" ? L10n.editorSettingsWeightNormal() : $0)
    }
    /// The margin's stepper on the page takes any whole number up to 200; its page offers these.
    static let margins: [Double] = [0, 20, 40, 60, 80, 100, 150, 200]

    private func whole(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0)))
    }

    private func decimal(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(1)))
    }

    private func numbers(_ key: String, _ values: [Double], _ format: (Double) -> String) -> [Choice] {
        .numbers(values, stored: store.editor[key]?.number, format: format)
    }

    private func flag(_ key: String, disabled: Bool = false) -> some View {
        let note = disabled ? catalog("editorSettings.readableWidthNote") : catalog("editorSettings.\(key)Hint")
        return ToggleRow(title: catalog("editorSettings.\(key)"), detail: note, isOn: store.flag(key)) {
            store.setEditor(key, .bool($0))
        }
        .disabled(disabled)
    }

    private func choice(_ key: String, _ choices: [Choice]) -> some View {
        let title = catalog("editorSettings.\(key)")
        let current = store.editor[key]
        return NavigationRow(title: title, value: choices.first { $0.value == current }?.title) {
            router.push(
                SettingsHosting(
                    title: title,
                    ChoicePage(
                        store: store, choices: choices, footer: catalog("editorSettings.\(key)Hint"),
                        selected: { [store] in store.editor[key] },
                        choose: { [store] in store.setEditor(key, $0) })))
        }
    }
}
