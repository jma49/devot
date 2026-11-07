import SwiftUI

/// Note Font: the families the iPhone has, each in its own face, then the imported files and Add a
/// Font…, which hands Rust a copy of the picked file.
struct NoteFontPage: View {
    let store: SettingsStore
    let addFont: () -> Void
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 16
    @ScaledMetric(relativeTo: .body) private var check: CGFloat = 18

    var body: some View {
        let family = store.editor["fontFamily"]?.string ?? "mono"
        let imported = store.editor["importedFont"]?.string
        Form {
            Section {
                ForEach(Self.families(chosen: family), id: \.self) { id in
                    row(Self.name(family: id), font: NoteFont(family: id, installed: store.editor["installedFont"]?.string),
                        chosen: family == id) {
                        store.setEditor("fontFamily", .string(id))
                    }
                }
            }
            Section {
                ForEach(store.fontFiles, id: \.id) { file in
                    row(file.name, font: NoteFont(family: "system"), chosen: family == "imported" && imported == file.id) {
                        store.setEditor(["fontFamily": .string("imported"), "importedFont": .string(file.id)])
                    }
                }
                ActionRow(title: L10n.phoneSettingsAppearanceAddFont(), action: addFont)
            } header: {
                Header(L10n.phoneSettingsAppearanceImportedFonts())
            } footer: {
                Footer(L10n.phoneSettingsAppearanceFontFooter())
            }
        }
        .settingsPage(store)
        .sensoryFeedback(.selection, trigger: [family, imported ?? ""])
        .onAppear { store.loadFonts() }
    }

    /// Installed Font has no list on the iPhone, so it shows only while it is the choice.
    static func families(chosen: String) -> [String] {
        NoteFont.families + (chosen == "installed" ? ["installed"] : [])
    }

    static func name(family: String) -> String {
        catalog("editorSettings.font.\(family)")
    }

    /// The Note Font row's value: the family's name, or the imported file's.
    static func value(editor: [String: JSONValue], files: [FontFile]) -> String {
        let family = editor["fontFamily"]?.string ?? "mono"
        guard family == "imported", let id = editor["importedFont"]?.string else { return name(family: family) }
        return files.first { $0.id == id }?.name ?? (id as NSString).deletingPathExtension
    }

    private func row(_ title: String, font: NoteFont, chosen: Bool, choose: @escaping () -> Void) -> some View {
        Button(action: choose) {
            HStack {
                Text(title).font(font.font(size: size)).foregroundStyle(Color(Tokens.Color.phoneText))
                Spacer(minLength: Tokens.Size.phoneGroupedGap)
                if chosen {
                    Image(systemName: "checkmark")
                        .font(.system(size: check, weight: .semibold))
                        .foregroundStyle(Color(Tokens.Color.accentText))
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
        .settingsRow()
    }
}
