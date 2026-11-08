import UIKit

/// A note row (design/phone.md, Note list rows): the status mark, the title with the time, then the
/// first tag and the excerpt on a second line that is there from the first paint.
final class NoteCell: UICollectionViewListCell {
    private let mark = UIImageView()
    private var shown: (id: String, status: String, excerpt: Bool)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        mark.contentMode = .scaleAspectFit
        mark.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .body)
        mark.adjustsImageSizeForAccessibilityContentSizeCategory = true
        // The status and the pin are read in the row's value. Left to UIKit, the row reads as an image.
        mark.accessibilityElementsHidden = true
        accessibilityTraits = .button
        configurationUpdateHandler = { cell, state in
            var background = UIBackgroundConfiguration.listCell().updated(for: state)
            background.backgroundColor =
                state.isHighlighted || state.isSelected ? Tokens.Color.phonePressed : Tokens.Color.phoneBackground
            cell.backgroundConfiguration = background
        }
    }

    required init?(coder: NSCoder) { nil }

    struct Row {
        let note: NoteRow
        let excerpt: String?
        let tag: LibraryTag?
        let now: Date
        let reduceMotion: Bool
    }

    func show(_ row: Row) {
        let note = row.note
        let status = NoteStatus(rawValue: note.status) ?? .none
        let previous = shown?.id == note.id ? shown : nil
        shown = (note.id, note.status, row.excerpt != nil)

        mark.image = UIImage(systemName: status.symbol)
        mark.tintColor = Self.color(status)
        var content = UIListContentConfiguration.subtitleCell()
        content.text = Self.title(note, excerpt: row.excerpt)
        content.textProperties.font = UIFont.preferredFont(forTextStyle: .body)
        content.textProperties.color = Tokens.Color.phoneText
        let large = traitCollection.preferredContentSizeCategory.isAccessibilityCategory
        content.textProperties.numberOfLines = large ? 2 : 1
        content.secondaryText = Self.second(row)
        content.secondaryTextProperties.font = UIFont.preferredFont(forTextStyle: .subheadline)
        content.secondaryTextProperties.color = Tokens.Color.phoneTextSecondary
        content.secondaryTextProperties.numberOfLines = large ? 2 : 1
        content.textToSecondaryTextVerticalPadding = 2
        content.directionalLayoutMargins.top = Tokens.Size.phoneRowPad
        content.directionalLayoutMargins.bottom = Tokens.Size.phoneRowPad
        let excerptArrived = previous.map { !$0.excerpt && row.excerpt != nil } ?? false
        if excerptArrived, !row.reduceMotion {
            UIView.transition(
                with: contentView, duration: Tokens.Duration.phoneEnter, options: .transitionCrossDissolve,
                animations: { self.contentConfiguration = content })
        } else {
            contentConfiguration = content
        }

        var accessories: [UICellAccessory] = [
            .customView(configuration: .init(customView: mark, placement: .leading(), reservedLayoutWidth: .custom(Tokens.Size.iconPhoneStatus))),
            .label(
                text: Self.time(note.updatedAt, now: row.now),
                options: .init(tintColor: Tokens.Color.phoneTextFaint, font: Self.figures)),
        ]
        if note.pinned {
            let pin = UIImageView(image: UIImage(systemName: "pin.fill"))
            pin.tintColor = Tokens.Color.phoneTextFaint
            pin.accessibilityElementsHidden = true
            pin.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .caption1)
            accessories.append(.customView(configuration: .init(customView: pin, placement: .trailing())))
        }
        accessories.append(.multiselect(displayed: .whenEditing))
        self.accessories = accessories
        accessibilityValue = [status == .none ? nil : status.name, note.pinned ? L10n.sidebarPinned() : nil]
            .compactMap { $0 }.joined(separator: ", ")

        if let previous, previous.status != note.status, !row.reduceMotion { bump() }
    }

    /// The status mark grows and springs back when the status changes (design/motion.md, Status mark).
    private func bump() {
        let scale = Tokens.Scale.phoneBump
        mark.transform = CGAffineTransform(scaleX: scale, y: scale)
        let spring = Tokens.Spring.bouncy
        UIView.animate(springDuration: spring.response, bounce: spring.bounce) { self.mark.transform = .identity }
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        mark.layer.removeAllAnimations()
        mark.transform = .identity
    }

    static func title(_ note: NoteRow, excerpt: String?) -> String {
        if !note.title.isEmpty { return note.title }
        let first = excerpt?.split(separator: "\n").first.map(String.init) ?? ""
        return first.isEmpty ? L10n.noteUntitled() : first
    }

    /// One space while the excerpt is on its way keeps the row two lines tall from the first paint.
    private static func second(_ row: Row) -> String {
        let excerpt = row.excerpt ?? " "
        guard let tag = row.tag else { return excerpt }
        return "#\(tag.name) \(excerpt)"
    }

    static func color(_ status: NoteStatus) -> UIColor {
        switch status {
        case .none: Tokens.Color.phoneStatusNone
        case .active: Tokens.Color.statusActiveMark
        case .onHold: Tokens.Color.statusHoldMark
        case .completed: Tokens.Color.statusDoneMark
        case .dropped: Tokens.Color.statusDroppedMark
        }
    }

    private static var figures: UIFont {
        let size = UIFont.preferredFont(forTextStyle: .subheadline).pointSize
        return UIFont.monospacedDigitSystemFont(ofSize: size, weight: .regular)
    }

    /// Today's time, else the day, with the year only when it is not this one.
    static func time(_ updatedAt: Double, now: Date) -> String {
        let date = Date(timeIntervalSince1970: updatedAt / 1000)
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(date: .omitted, time: .shortened) }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return date.formatted(.dateTime.month(.abbreviated).day())
        }
        return date.formatted(date: .numeric, time: .omitted)
    }
}
