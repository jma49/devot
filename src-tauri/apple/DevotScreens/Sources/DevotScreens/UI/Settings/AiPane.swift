import SwiftUI

/// AI: the licence's notice while AI is locked, the provider, its endpoint, model and key, and
/// Suggest on Idle (`AiSection.tsx`, its phone layout).
struct AiPane: View {
    let store: SettingsStore
    let buy: () -> Void
    @State private var endpoint = ""
    @State private var model = ""
    @State private var key = ""
    @State private var problem: String?
    @State private var announcement: String?

    var body: some View {
        Form {
            if let problem { ProblemRow(text: problem) }
            if let licence = store.licence, !licence.allows(store.now) {
                Section(L10n.licenceSettingsTitle()) {
                    Text(LicenceText.aiLocked(licence, store.now)).settingsDetail()
                        .listRowBackground(Color(Tokens.Color.phoneCard))
                    ActionRow(title: licence.soldOnAppStore ? L10n.licenceSettingsBuyPro() : L10n.licenceSettingsBuy(), action: buy)
                }
            }
            if let view = store.ai {
                providerSection(view)
                Section {
                    ToggleRow(title: L10n.aiSettingsSuggestOnIdle(), isOn: view.suggestOnIdle) { on in
                        var next = view
                        next.suggestOnIdle = on
                        store.setAi(next)
                    }
                } header: {
                    Text(L10n.phoneAiFeatures())
                } footer: {
                    Footer(L10n.phoneAiSuggestHint())
                }
            }
        }
        .settingsPage(store)
        .onAppear(perform: fill)
        .onChange(of: store.ai?.active) { fill() }
    }

    private func providerSection(_ view: AiView) -> some View {
        let shown = view[view.active]
        let name = catalog("aiSettings.provider.\(view.active)")
        return Section {
            // A closure, not `set: choose`: Swift 6.3's IR generation crashes on that method reference's thunk.
            Picker(L10n.phoneAiProvider(), selection: Binding(get: { view.active }, set: { choose($0) })) {
                ForEach(AiView.providers, id: \.self) { Text(catalog("aiSettings.provider.\($0)")).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .listRowBackground(Color(Tokens.Color.phoneCard))
            field(L10n.aiSettingsEndpoint(), L10n.aiSettingsEndpointHint(), $endpoint, shown.defaultEndpoint)
            field(
                L10n.aiSettingsModel(),
                shown.defaultModel.isEmpty ? L10n.aiSettingsModelRequiredHint() : L10n.aiSettingsModelHint(), $model,
                shown.defaultModel)
            VStack(alignment: .leading, spacing: Tokens.Space.space4) {
                RowText(title: L10n.aiSettingsKey(), detail: L10n.phoneAiKeyHint())
                SecureField(L10n.aiSettingsKeyLabel(provider: name), text: $key)
                    .textContentType(.password)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .disabled(shown.key == "unavailable")
                Text(Self.keyStates[shown.key] ?? L10n.aiSettingsKeyUnknown()).settingsDetail()
                if let announcement { Text(announcement).settingsDetail() }
            }
            .settingsRow(described: true)
            ActionRow(title: L10n.aiSettingsSaveKey()) { saveKey(view.active) }
                .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty || shown.key == "unavailable")
            ActionRow(title: L10n.aiSettingsRemoveKey(), destructive: true) { removeKey(view.active) }
                .disabled(shown.key != "set" && shown.key != "unknown")
        } header: {
            Text(L10n.phoneAiProvider())
        } footer: {
            Footer(L10n.aiSettingsDetail())
        }
    }

    static let keyStates = [
        "set": L10n.aiSettingsKeySet(), "unset": L10n.aiSettingsKeyUnset(), "unknown": L10n.aiSettingsKeyUnknown(),
        "unavailable": L10n.aiSettingsKeyUnavailable(),
    ]

    private func field(_ title: String, _ detail: String, _ text: Binding<String>, _ placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.space4) {
            RowText(title: title, detail: detail)
            TextField(placeholder, text: text)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.done)
                .onSubmit(commit)
        }
        .settingsRow(described: true)
    }

    private func fill() {
        guard let view = store.ai else { return }
        endpoint = view[view.active].endpoint
        model = view[view.active].model
        key = ""
    }

    private func choose(_ active: String) {
        guard var next = store.ai else { return }
        next[next.active].endpoint = endpoint
        next[next.active].model = model
        next.active = active
        store.setAi(next)
    }

    private func commit() {
        guard var next = store.ai else { return }
        next[next.active].endpoint = endpoint
        next[next.active].model = model
        store.setAi(next)
    }

    private func saveKey(_ provider: String) {
        changeKey(.aiKeySet, ["provider": .string(provider), "key": .string(key)], L10n.aiSettingsKeySaved)
    }

    private func removeKey(_ provider: String) {
        changeKey(.aiKeyClear, ["provider": .string(provider)], L10n.aiSettingsKeyRemoved)
    }

    private func changeKey(_ op: DirectOp, _ args: [String: JSONValue], _ done: @escaping (String) -> String) {
        let provider = args["provider"]?.string ?? ""
        let name = catalog("aiSettings.provider.\(provider)")
        store.run(op, args) { result in
            switch result {
            case .success(let value):
                if let view = AiView(value) { store.ai = view }
                key = ""
                problem = nil
                announcement = done(name)
            case .failure(let failure):
                store.log("W_PHONE_SETTINGS_SAVE_FAILED key=aiKey code=\(failure.code)")
                announcement = nil
                problem = LicenceText.failure(L10n.aiSettingsKeyFailed(), failure.code)
            }
        }
    }
}
