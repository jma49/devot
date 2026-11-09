import UIKit

extension UICollectionViewListCell {
    /// Paints the row in the theme's card colour: left to UIKit, a grouped row takes the system's grey
    /// whatever the theme.
    func paintAsCard() {
        configurationUpdateHandler = { cell, state in
            var background = UIBackgroundConfiguration.listCell().updated(for: state)
            background.backgroundColor =
                state.isHighlighted || state.isSelected ? Tokens.Color.phonePressed : Tokens.Color.phoneCard
            cell.backgroundConfiguration = background
        }
    }
}
