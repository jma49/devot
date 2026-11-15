import SwiftUI

/// General: App Language, Default Notebook, and Send Crash Reports where this build can send them.
struct GeneralPane: View {
    let store: SettingsStore
    let router: SettingsRouter
    @State private var language = AppLanguage()

    var body: some View {
        let choices =
            [Choice(value: .null, title: L10n.generalSettingsNoNotebook())]
            + store.notebooks.map { Choice(value: .string($0.id), title: $0.name, depth: $0.depth) }
        let current = store.editor["defaultNotebook"] ?? .null
        Form {
            Section {
                NavigationRow(title: L10n.generalSettingsLanguage(), value: AppLanguage.title(language.chosen)) {
                    router.push(
                        SettingsHosting(
                            title: L10n.generalSettingsLanguage(),
                            ChoicePage(
                                store: store,
                                choices: AppLanguage.choices.map { Choice(value: .string($0), title: AppLanguage.title($0)) },
                                footer: L10n.generalSettingsLanguageHint(),
                                selected: { [language] in .string(language.chosen) },
                                choose: { [language] in language.choose($0.string ?? "system") })))
                }
            } header: {
                Header(L10n.generalSettingsLanguageGroup())
            }
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
