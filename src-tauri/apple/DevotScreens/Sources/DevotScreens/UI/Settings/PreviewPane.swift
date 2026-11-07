import SwiftUI

/// Preview: Load Images from the Web.
struct PreviewPane: View {
    let store: SettingsStore

    var body: some View {
        Form {
            ToggleRow(
                title: L10n.previewSettingsRemoteImages(), detail: L10n.previewSettingsRemoteImagesHint(),
                isOn: store.flag("loadRemoteImages")
            ) { store.setEditor("loadRemoteImages", .bool($0)) }
        }
        .settingsPage(store)
    }
}
