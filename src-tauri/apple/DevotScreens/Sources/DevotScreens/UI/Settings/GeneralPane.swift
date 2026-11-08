import SwiftUI

/// General: Default Notebook, and Send Crash Reports where this build can send them.
struct GeneralPane: View {
    let store: SettingsStore
    let router: SettingsRouter

    var body: some View {
        let choices =
            [Choice(value: .null, title: L10n.generalSettingsNoNotebook())]
            + store.notebooks.map { Choice(value: .string($0.id), title: $0.name, depth: $0.depth) }
        let current = store.editor["defaultNotebook"] ?? .null
        Form {
            Section {
                NavigationRow(
                    title: L10n.generalSettingsDefaultNotebook(),
                    value: choices.first { $0.value == current }?.title ?? L10n.generalSettingsNoNotebook()
                ) {
                    router.push(
                        SettingsHosting(
                            title: L10n.generalSettingsDefaultNotebook(),
                            ChoicePage(
                                store: store, choices: choices, footer: L10n.phoneSettingsDefaultNotebookFooter(),
                                selected: { [store] in store.editor["defaultNotebook"] ?? .null },
                                choose: { [store] in store.setEditor("defaultNotebook", $0) })))
                }
            } header: {
                Header(L10n.generalSettingsDefaults())
            }
            if let reports = store.crashReports, reports.available {
                Section {
                    ToggleRow(
                        title: L10n.generalSettingsCrashReports(), detail: L10n.generalSettingsCrashReportsHint(),
                        isOn: reports.on, set: store.setCrashReports)
                } header: {
                    Header(L10n.generalSettingsData())
                }
            }
        }
        .settingsPage(store)
    }
}
