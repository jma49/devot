import UIKit

/// The shadow under one of Devot's two glass views, drawn from a path so no offscreen pass runs.
final class FloatShadowView: UIView {
    var cornerRadius: CGFloat = 0 {
        didSet { setNeedsLayout() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        layer.shadowOpacity = 1
        layer.shadowOffset = CGSize(width: 0, height: Tokens.Shadow.phoneFloatOffset)
        layer.shadowRadius = Tokens.Shadow.phoneFloatRadius
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: Self, _) in view.refresh() }
        refresh()
    }

    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: cornerRadius).cgPath
    }

    private func refresh() {
        layer.shadowColor = Tokens.Color.phoneFloatShadow.resolvedColor(with: traitCollection).cgColor
    }
}
