import Observation

/// The AI pane's typed endpoint and model, one draft per provider. A draft is refilled only from
/// a view Rust confirmed, so a refused change, a provider switch among them, keeps what was typed.
@Observable
@MainActor
final class AiDrafts {
    struct Draft: Equatable {
        var endpoint: String
        var model: String
    }

    let store: SettingsStore
    private var typed: [String: Draft] = [:]

    init(store: SettingsStore) {
        self.store = store
    }

    subscript(provider: String) -> Draft? {
        get { typed[provider] }
        set { typed[provider] = newValue }
    }

    /// Fills the drafts from the stored view the first time there is one.
    func fill() {
        guard typed.isEmpty, let view = store.ai else { return }
        for provider in AiView.providers {
            typed[provider] = Draft(endpoint: view[provider].endpoint, model: view[provider].model)
        }
    }

    /// Stores the drafts, and `active` when given; a draft Rust took shows the value Rust kept.
    func commit(active: String? = nil) {
        guard var next = store.ai else { return }
        let sent = typed
        for (provider, draft) in sent {
            next[provider].endpoint = draft.endpoint
            next[provider].model = draft.model
        }
        if let active { next.active = active }
        store.setAi(next) { [weak self] confirmed in
            guard let self, let confirmed else { return }
            for provider in AiView.providers where typed[provider] == sent[provider] {
                typed[provider] = Draft(endpoint: confirmed[provider].endpoint, model: confirmed[provider].model)
            }
        }
    }
}
