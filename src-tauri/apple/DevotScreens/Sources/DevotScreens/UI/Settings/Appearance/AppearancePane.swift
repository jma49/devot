import SwiftUI

/// Appearance (design-settings §3): colour scheme, theme, the gradient while a gradient theme is
/// chosen, this iPhone's glass, text sizes, Note Font and motion.
struct AppearancePane: View {
    let store: SettingsStore
    let themes: ThemeStore
    let glass: GlassStyleStore
    let router: SettingsRouter
    let addFont: () -> Void

    var body: some View {
        Form {
            Section {
                SchemeCards(store: store, themes: themes).cardRow()
            } header: {
                Header(catalog("appearanceSettings.colorScheme"))
            }
            Section {
                ThemeGrid(store: store, themes: themes).cardRow()
            } header: {
                Header(L10n.phoneSettingsAppearanceThemes())
            } footer: {
                Footer(L10n.phoneSettingsAppearanceThemesFooter())
            }
            if themes.gradientShown {
                Section {
                    GradientCard(store: store, themes: themes)
                } header: {
                    Header(catalog("appearanceSettings.gradient"))
                }
            }
            Section {
                GlassCard(glass: glass)
            } header: {
                Header(L10n.phoneSettingsAppearanceGlass())
            } footer: {
                if glass.reduced { Footer(L10n.phoneSettingsAppearanceTransparencyReduced()) }
            }
            Section {
                TextCard(store: store)
            } header: {
                Header(L10n.phoneSettingsAppearanceText())
            }
            Section {
                let title = catalog("editorSettings.noteFont")
                NavigationRow(title: title, value: NoteFontPage.value(editor: store.editor, files: store.fontFiles)) {
                    router.push(SettingsHosting(title: title, NoteFontPage(store: store, addFont: addFont)))
                }
            } header: {
                Header(L10n.phoneSettingsAppearanceFonts())
            }
            MotionRows(store: store)
        }
        .settingsPage(store)
        .onAppear { store.loadFonts() }
    }
}

extension View {
    /// Cards that sit in a section on the page's background rather than on a grouped card.
    func cardRow() -> some View {
        listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }
}
