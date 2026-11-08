import UIKit

/// Keeps the reader's place in a list while its content changes size, as a larger text size does:
/// SwiftUI's list passes through a short content size on the way, which drops its offset, and the
/// accessibility audit's Dynamic Type check reads text that leaves the screen as text that does not
/// scale. After a text size change the first row or header that starts on the screen keeps its
/// place; a list that keeps its foot keeps it in view once the reader has scrolled there.
@MainActor
final class PlaceKeeper {
    private struct Anchor {
        let kind: String?
        let path: IndexPath
        let fromTop: CGFloat
    }

    let list: UIScrollView
    private let keepsTheFoot: Bool
    private let movedByTheReader: @MainActor (UIScrollView) -> Bool
    private var observations: [NSKeyValueObservation] = []
    private var adjusting = false
    private var anchor: Anchor?
    /// Set from a text size change until the reader scrolls: otherwise the list's own settling, as rows
    /// learn their heights, is left alone.
    private var textSizeChanged = false
    private(set) var atTheFoot = false

    init(_ list: UIScrollView, keepsTheFoot: Bool = false, movedByTheReader: @escaping @MainActor (UIScrollView) -> Bool = {
        $0.isTracking || $0.isDragging || $0.isDecelerating
    }) {
        self.list = list
        self.keepsTheFoot = keepsTheFoot
        self.movedByTheReader = movedByTheReader
        observations = [
            list.observe(\.contentOffset) { [weak self] _, _ in MainActor.assumeIsolated { self?.moved() } },
            list.observe(\.contentSize) { [weak self] _, _ in MainActor.assumeIsolated { self?.resized() } },
        ]
        list.registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { [weak self] (_: UIScrollView, _) in
            self?.textSizeChanged = true
        }
    }

    private var top: CGFloat { -list.adjustedContentInset.top }

    private var foot: CGFloat {
        max(top, list.contentSize.height + list.adjustedContentInset.bottom - list.bounds.height)
    }

    /// Only the reader's own scrolling marks the place: the list moves itself while it lays out.
    private func moved() {
        guard !adjusting, movedByTheReader(list) else { return }
        atTheFoot = keepsTheFoot && list.contentOffset.y >= foot - 1
        textSizeChanged = false
        mark()
    }

    private func resized() {
        guard !adjusting, !movedByTheReader(list) else { return }
        let target: CGFloat
        if atTheFoot {
            target = foot
        } else if textSizeChanged, let anchor, let frame = frame(of: anchor) {
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

    /// Found among the list's elements rather than asked for: asking for a header or footer that is gone
    /// raises an exception.
    private func frame(of anchor: Anchor) -> CGRect? {
        guard let collection = list as? UICollectionView else { return nil }
        let content = CGRect(origin: .zero, size: list.contentSize).insetBy(dx: 0, dy: -list.bounds.height)
        return collection.collectionViewLayout.layoutAttributesForElements(in: content)?
            .first { $0.indexPath == anchor.path && $0.representedElementKind == anchor.kind }?.frame
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
