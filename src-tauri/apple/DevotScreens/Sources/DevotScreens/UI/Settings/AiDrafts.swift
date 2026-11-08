import Observation

/// The AI pane's typed endpoint and model, one draft per provider. A draft is refilled only from
/// a view Rust confirmed, so a refused change, a provider switch among them, keeps what was typed.
/// Leaving a field or the pane stores what was typed, as the page does on blur.
@Observable
@MainActor
final class AiDrafts {
    struct Draft: Equatable {
        var endpoint: String
        var model: String
    }

    let store: SettingsStore
    private var typed: [String: Draft] = [:]
    @ObservationIgnored private var refused: [String: Draft] = [:]

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

    /// Stores the drafts with `change`; a draft Rust took shows the value Rust kept. Without a
    /// Return or a switch (`skippingRefused`), a draft Rust refused is not sent again until edited.
    func commit(skippingRefused: Bool = false, _ change: (inout AiView) -> Void = { _ in }) {
        guard var next = store.ai else { return }
        let sent = typed.filter { !skippingRefused || refused[$0.key] != $0.value }
        for (provider, draft) in sent {
            next[provider].endpoint = draft.endpoint
            next[provider].model = draft.model
        }
        change(&next)
        store.setAi(next) { [weak self] confirmed in
            guard let self else { return }
            guard let confirmed else {
                refused.merge(sent) { $1 }
                return
            }
            for provider in sent.keys { refused[provider] = nil }
            for provider in AiView.providers where typed[provider] == sent[provider] {
                typed[provider] = Draft(endpoint: confirmed[provider].endpoint, model: confirmed[provider].model)
            }
        }
    }
}
