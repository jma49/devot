import UIKit

/// Keeps the reader's place in a list while its content changes size, as a larger text size does:
/// SwiftUI's list passes through a short content size on the way, which drops its offset, and the
/// accessibility audit's Dynamic Type check reads text that leaves the screen as text that does not
/// scale. Once the reader has scrolled to the foot the foot stays in view; elsewhere the first row
/// or header that starts on the screen keeps its place.
@MainActor
final class PlaceKeeper {
    private struct Anchor {
        let kind: String?
        let path: IndexPath
        let fromTop: CGFloat
    }

    let list: UIScrollView
    private let movedByTheReader: @MainActor (UIScrollView) -> Bool
    private var observations: [NSKeyValueObservation] = []
    private var adjusting = false
    private var anchor: Anchor?
    private(set) var atTheFoot = false

    init(_ list: UIScrollView, movedByTheReader: @escaping @MainActor (UIScrollView) -> Bool = {
        $0.isTracking || $0.isDragging || $0.isDecelerating
    }) {
        self.list = list
        self.movedByTheReader = movedByTheReader
        observations = [
            list.observe(\.contentOffset) { [weak self] _, _ in MainActor.assumeIsolated { self?.moved() } },
            list.observe(\.contentSize) { [weak self] _, _ in MainActor.assumeIsolated { self?.resized() } },
        ]
    }

    private var top: CGFloat { -list.adjustedContentInset.top }

    private var foot: CGFloat {
        max(top, list.contentSize.height + list.adjustedContentInset.bottom - list.bounds.height)
    }

    /// Only the reader's own scrolling marks the place: the list moves itself while it lays out.
    private func moved() {
        guard !adjusting, movedByTheReader(list) else { return }
        atTheFoot = list.contentOffset.y >= foot - 1
        mark()
    }

    private func resized() {
        guard !adjusting, !movedByTheReader(list) else { return }
        let target: CGFloat
        if atTheFoot {
            target = foot
        } else if let anchor, let frame = frame(of: anchor) {
            target = min(max(frame.minY - anchor.fromTop + top, top), foot)
        } else {
            return
        }
        if abs(list.contentOffset.y - target) > 0.5 {
            adjusting = true
            list.contentOffset.y = target
            adjusting = false
        }
    }

    private func mark() {
        guard let collection = list as? UICollectionView, list.contentOffset.y > top + 0.5 else {
            anchor = nil
            return
        }
        let shown = list.contentOffset.y - top
        let visible = CGRect(x: 0, y: shown, width: list.bounds.width, height: list.bounds.height)
        let elements = (collection.collectionViewLayout.layoutAttributesForElements(in: visible) ?? [])
            .filter { $0.representedElementCategory != .decorationView }
        let first = elements.filter { $0.frame.minY >= shown - 0.5 }.min { $0.frame.minY < $1.frame.minY }
            ?? elements.max { $0.frame.minY < $1.frame.minY }
        anchor = first.map {
            Anchor(kind: $0.representedElementKind, path: $0.indexPath, fromTop: $0.frame.minY - shown)
        }
    }

    private func frame(of anchor: Anchor) -> CGRect? {
        guard let collection = list as? UICollectionView else { return nil }
        let layout = collection.collectionViewLayout
        if let kind = anchor.kind { return layout.layoutAttributesForSupplementaryView(ofKind: kind, at: anchor.path)?.frame }
        return layout.layoutAttributesForItem(at: anchor.path)?.frame
    }
}

extension UIView {
    func firstSubview<View: UIView>(of type: View.Type) -> View? {
        for subview in subviews {
            if let match = subview as? View ?? subview.firstSubview(of: type) { return match }
        }
        return nil
    }
}
