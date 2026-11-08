import UIKit

@MainActor
private func label(_ style: UIFont.TextStyle, secondary: Bool = false) -> UILabel {
    let label = UILabel()
    label.font = .preferredFont(forTextStyle: style)
    label.adjustsFontForContentSizeCategory = true
    label.numberOfLines = 0
    if secondary { label.textColor = Tokens.Color.phoneTextSecondary }
    return label
}

@MainActor
private var shades: [UIColor] {
    [
        Tokens.Color.activityLevel0, Tokens.Color.activityLevel1, Tokens.Color.activityLevel2,
        Tokens.Color.activityLevel3, Tokens.Color.activityLevel4,
    ]
}

@MainActor
private func shade(_ level: Int) -> UIColor { shades[min(max(level, 0), shades.count - 1)] }

/// The weeks' cells and the month names over them, drawn as one picture that VoiceOver reads as a summary.
final class HeatmapGrid: UIView {
    var writing: ActivityWriting? {
        didSet {
            months = writing.map { ActivityWriting.monthLabels(first: $0.first, weeks: ActivityWriting.weeks) } ?? []
            invalidateIntrinsicContentSize()
            setNeedsLayout()
            setNeedsDisplay()
        }
    }

    private var months: [String] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        contentMode = .redraw
        isAccessibilityElement = true
        accessibilityTraits = .image
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (grid: Self, _) in
            grid.invalidateIntrinsicContentSize()
            grid.setNeedsLayout()
            grid.setNeedsDisplay()
        }
    }

    required init?(coder: NSCoder) { nil }

    private var metrics: UIFontMetrics { UIFontMetrics(forTextStyle: .caption2) }
    private var gap: CGFloat { metrics.scaledValue(for: Tokens.Size.phoneHeatGap, compatibleWith: traitCollection) }
    private var monthFont: UIFont { .preferredFont(forTextStyle: .caption2, compatibleWith: traitCollection) }
    private var monthHeight: CGFloat { monthFont.lineHeight }

    /// The scaled cell, shrunk to fit the weeks across the width it has.
    private var cell: CGFloat {
        let scaled = metrics.scaledValue(for: Tokens.Size.phoneHeatCell, compatibleWith: traitCollection)
        let weeks = CGFloat(ActivityWriting.weeks)
        guard bounds.width > 0 else { return scaled }
        return min(scaled, (bounds.width - (weeks - 1) * gap) / weeks)
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: writing == nil ? 0 : monthHeight + gap + 7 * cell + 6 * gap)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if abs(intrinsicContentSize.height - bounds.height) > 0.5 { invalidateIntrinsicContentSize() }
    }

    /// Where each month's name is drawn: over its week, kept inside the grid.
    var monthFrames: [CGRect] {
        let attributes: [NSAttributedString.Key: Any] = [.font: monthFont]
        return months.enumerated().map { week, month in
            guard !month.isEmpty else { return .null }
            let width = min(ceil((month as NSString).size(withAttributes: attributes).width), bounds.width)
            let x = min(CGFloat(week) * (cell + gap), bounds.width - width)
            return CGRect(x: max(x, 0), y: 0, width: width, height: monthHeight)
        }
    }

    override func draw(_ rect: CGRect) {
        guard let writing else { return }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: monthFont, .foregroundColor: Tokens.Color.phoneTextSecondary,
        ]
        for (month, frame) in zip(months, monthFrames) where !frame.isNull {
            (month as NSString).draw(in: frame, withAttributes: attributes)
        }
        let top = monthHeight + gap
        let radius = Tokens.Radius.phoneHeatCell
        for (week, column) in writing.grid.enumerated() {
            for (row, level) in column.enumerated() {
                guard let level else { continue }
                let frame = CGRect(x: CGFloat(week) * (cell + gap), y: top + CGFloat(row) * (cell + gap), width: cell, height: cell)
                shade(level).setFill()
                UIBezierPath(roundedRect: frame, cornerRadius: radius).fill()
            }
        }
    }
}

/// The heatmap's row: its head, the grid and the shades' legend.
final class HeatmapCell: UICollectionViewListCell {
    let grid = HeatmapGrid()
    private let title = label(.headline)
    private let span = label(.caption1, secondary: true)
    private var legendSides: [NSLayoutConstraint] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        title.text = L10n.phoneActivityWriting()
        title.accessibilityTraits = .header
        span.text = L10n.phoneActivitySpan(weeks: String(ActivityWriting.weeks))
        span.textAlignment = .right
        let head = UIStackView(arrangedSubviews: [title, span])
        head.alignment = .firstBaseline
        head.spacing = Tokens.Space.space4
        span.setContentHuggingPriority(.required, for: .horizontal)
        title.setContentCompressionResistancePriority(.required, for: .horizontal)

        // Caption 2 keeps one size below the default text size; the legend's words follow every size.
        let less = label(.caption1, secondary: true)
        less.text = L10n.phoneActivityLess()
        let more = label(.caption1, secondary: true)
        more.text = L10n.phoneActivityMore()
        let squares = (0...ActivityWriting.levels).map { level -> UIView in
            let square = UIView()
            square.backgroundColor = shade(level)
            square.layer.cornerRadius = Tokens.Radius.phoneHeatCell
            square.translatesAutoresizingMaskIntoConstraints = false
            let side = square.widthAnchor.constraint(equalToConstant: Tokens.Size.phoneHeatLegend)
            legendSides.append(side)
            NSLayoutConstraint.activate([side, square.heightAnchor.constraint(equalTo: square.widthAnchor)])
            return square
        }
        let legend = UIStackView(arrangedSubviews: [less] + squares + [more])
        legend.alignment = .center
        legend.spacing = Tokens.Size.phoneHeatGap
        let legendRow = UIStackView(arrangedSubviews: [legend, UIView()])

        let stack = UIStackView(arrangedSubviews: [head, grid, legendRow])
        stack.axis = .vertical
        stack.spacing = Tokens.Space.space4
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)
        let margins = contentView.layoutMarginsGuide
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: margins.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: margins.trailingAnchor),
            stack.topAnchor.constraint(equalTo: margins.topAnchor, constant: Tokens.Space.space4),
            stack.bottomAnchor.constraint(equalTo: margins.bottomAnchor, constant: -Tokens.Space.space4),
        ])
        scaleTheLegend()
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (cell: Self, _) in cell.scaleTheLegend() }
    }

    required init?(coder: NSCoder) { nil }

    private func scaleTheLegend() {
        let scaled = UIFontMetrics(forTextStyle: .caption2).scaledValue(for: Tokens.Size.phoneHeatLegend, compatibleWith: traitCollection)
        // Past a heatmap cell's size the squares would push the legend's words onto a second line.
        for constraint in legendSides { constraint.constant = min(scaled, Tokens.Size.phoneHeatCell) }
    }

    func show(_ writing: ActivityWriting?) {
        grid.writing = writing
        grid.isHidden = writing == nil
        grid.accessibilityLabel = L10n.phoneActivitySummary(
            weeks: String(ActivityWriting.weeks), words: (writing?.totalWords ?? 0).formatted(),
            days: (writing?.activeDays ?? 0).formatted())
    }
}

/// The week's choice and its three figures.
final class FiguresCell: UICollectionViewListCell {
    let period = UISegmentedControl(items: [L10n.phoneActivityWeekThis(), L10n.phoneActivityWeekLast()])
    private(set) var values: [UILabel] = []
    private(set) var captions: [UILabel] = []
    var choose: ((ActivityWriting.Period) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        period.accessibilityLabel = L10n.phoneActivityPeriod()
        period.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            choose?(period.selectedSegmentIndex == 1 ? .last : .this)
        }, for: .valueChanged)

        let columns = (0..<3).map { _ -> UIStackView in
            let value = label(.title2)
            value.font = UIFontMetrics(forTextStyle: .title2).scaledFont(
                for: .monospacedDigitSystemFont(ofSize: Self.defaultSize(.title2), weight: .semibold))
            value.textAlignment = .center
            let caption = label(.caption1, secondary: true)
            caption.textAlignment = .center
            values.append(value)
            captions.append(caption)
            let column = UIStackView(arrangedSubviews: [value, caption])
            column.axis = .vertical
            column.spacing = Tokens.Space.space2
            return column
        }
        let figures = UIStackView(arrangedSubviews: columns)
        figures.distribution = .fillEqually
        figures.alignment = .top
        let stack = UIStackView(arrangedSubviews: [period, figures])
        stack.axis = .vertical
        stack.spacing = Tokens.Space.space6
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)
        let margins = contentView.layoutMarginsGuide
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: margins.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: margins.trailingAnchor),
            stack.topAnchor.constraint(equalTo: margins.topAnchor, constant: Tokens.Space.space4),
            stack.bottomAnchor.constraint(equalTo: margins.bottomAnchor, constant: -Tokens.Space.space4),
        ])
    }

    required init?(coder: NSCoder) { nil }

    private static func defaultSize(_ style: UIFont.TextStyle) -> CGFloat {
        UIFont.preferredFont(forTextStyle: style, compatibleWith: UITraitCollection(preferredContentSizeCategory: .large)).pointSize
    }

    func show(_ week: ActivityWriting.Week?, period chosen: ActivityWriting.Period) {
        period.selectedSegmentIndex = chosen == .last ? 1 : 0
        let figures = [
            (week?.words ?? 0, chosen == .last ? L10n.phoneActivityWordsLast() : L10n.phoneActivityWordsThis()),
            (week?.streak ?? 0, L10n.phoneActivityStreak()),
            (week?.notesEdited ?? 0, L10n.phoneActivityEdited()),
        ]
        for (index, figure) in figures.enumerated() {
            values[index].text = figure.0.formatted()
            captions[index].text = figure.1
        }
    }
}
