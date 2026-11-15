import Foundation
import Observation

/// General > App Language: the system's languages, or one picked for Devot alone. It is the app's
/// own `AppleLanguages` default, the one iOS Settings > Devot > Language writes too, so both show
/// the same choice; the screens and the editor read it when Devot opens.
@Observable
@MainActor
final class AppLanguage {
    static let choices = ["system", "en", "zh-Hans"]
    private static let key = "AppleLanguages"

    @ObservationIgnored private let defaults: UserDefaults
    private(set) var chosen: String

    init(defaults: UserDefaults = .standard, domain: String? = Bundle.main.bundleIdentifier) {
        self.defaults = defaults
        let tags = domain.flatMap { defaults.persistentDomain(forName: $0)?[Self.key] as? [String] }
        chosen = tags?.first.map(Self.choice(for:)) ?? "system"
    }

    /// The choice a language tag reads as, by the page's rules (`resolveLocale`): a language Devot
    /// does not ship, Traditional Chinese among them, counts as the system's.
    static func choice(for tag: String) -> String {
        let subtags = tag.lowercased().replacingOccurrences(of: "_", with: "-").split(separator: "-")
        switch subtags.first {
        case "en": return "en"
        case "zh" where subtags.dropFirst().contains(where: { ["hant", "tw", "hk", "mo"].contains($0) }): return "system"
        case "zh": return "zh-Hans"
        default: return "system"
        }
    }

    func choose(_ choice: String) {
        guard Self.choices.contains(choice) else { return }
        if choice == "system" {
            defaults.removeObject(forKey: Self.key)
        } else {
            defaults.set([choice], forKey: Self.key)
        }
        chosen = choice
    }

    /// Each language by its own name, so a reader lost in the other one still finds theirs.
    static func title(_ choice: String) -> String {
        guard choice != "system" else { return L10n.generalSettingsLanguageSystem() }
        return Locale(identifier: choice).localizedString(forIdentifier: choice) ?? choice
    }
}
