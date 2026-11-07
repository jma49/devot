import SwiftUI

/// The app card's sheet while a trial runs: when it ends, and Done.
struct TrialSheet: View {
    let endsAt: Date
    let store: Bool
    let done: () -> Void

    var body: some View {
        let date = endsAt.formatted(date: .abbreviated, time: .omitted)
        VStack(spacing: SheetMetrics.gap) {
            SheetLens(symbol: "info.circle")
            Text(L10n.phoneSettingsTrial()).sheetTitle().accessibilityAddTraits(.isHeader)
            Text(store ? L10n.phoneSettingsTrialEndsStore(date: date) : L10n.phoneSettingsTrialEnds(date: date))
                .sheetBody()
                .multilineTextAlignment(.center)
            SheetButton(title: L10n.phoneHintDone(), action: done)
                .accessibilityIdentifier("trial-done")
        }
        .padding(.horizontal, Tokens.Size.phoneGroupedPadX)
        .padding(.vertical, SheetMetrics.gap)
    }
}
