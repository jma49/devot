import UIKit

/// Keeps the first row or header on the screen in place when the text size changes, or the foot for a
/// list that keeps it: SwiftUI's list passes through a short content size on the way and drops its offset.
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
    private var markPending = false
    /// Until the reader scrolls: without a text size change the list's own settling is left alone.
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

    /// Only the reader's own scrolling moves the place: the list moves itself while it lays out.
    private func moved() {
        guard !adjusting, movedByTheReader(list) else { return }
        atTheFoot = keepsTheFoot && list.contentOffset.y >= foot - 1
        textSizeChanged = false
        guard !markPending else { return }
        markPending = true
        // A scroll holds the run loop in its tracking mode, so this marks once, as the scroll ends.
        RunLoop.main.perform(inModes: [.default]) { [weak self] in
            MainActor.assumeIsolated {
                self?.markPending = false
                self?.mark()
            }
        }
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

    /// Asking the layout for a header or footer that is gone raises an exception, so it is searched for.
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
