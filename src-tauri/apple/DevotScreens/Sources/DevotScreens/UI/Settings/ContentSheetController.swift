import SwiftUI
import UIKit

/// The sheet every short message uses: as tall as its content, up to nearly the full height, with
/// a grabber and the system's material and corners.
final class ContentSheetController: UIViewController {
    static let detent = UISheetPresentationController.Detent.Identifier("content")
    static let maximumShare: CGFloat = 0.92

    /// One custom detent's height: the content's, never above `maximumShare` of the most the sheet may take.
    static func height(content: CGFloat, maximum: CGFloat) -> CGFloat {
        min(content, maximum * maximumShare)
    }

    private let hosting: UIHostingController<AnyView>

    init(_ content: some View) {
        hosting = UIHostingController(rootView: AnyView(content))
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        hosting.sizingOptions = .preferredContentSize
        if let sheet = sheetPresentationController {
            sheet.detents = [.custom(identifier: Self.detent) { [weak self] context in
                let maximum = context.maximumDetentValue
                return MainActor.assumeIsolated {
                    self.map { Self.height(content: $0.contentHeight, maximum: maximum) }
                }
            }]
            sheet.prefersGrabberVisible = true
            sheet.prefersScrollingExpandsWhenScrolledToEdge = false
        }
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        hosting.view.backgroundColor = .clear
        addChild(hosting)
        hosting.view.frame = view.bounds
        hosting.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(hosting.view)
        hosting.didMove(toParent: self)
    }

    /// The content's height at the sheet's width.
    var contentHeight: CGFloat {
        let width = view.bounds.width > 0 ? view.bounds.width : (view.window?.bounds.width ?? 390)
        return hosting.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
    }

    override func preferredContentSizeDidChange(forChildContentContainer container: any UIContentContainer) {
        super.preferredContentSizeDidChange(forChildContentContainer: container)
        guard let sheet = sheetPresentationController else { return }
        sheet.animateChanges { sheet.invalidateDetents() }
    }
}
