import Observation
import UIKit

/// The iPhone's own Glass Transparency, kept in this device's defaults and never synced. Dragging
/// applies a value at once; only a release writes it.
@MainActor
@Observable
final class GlassStyleStore {
    static let key = "devot.phone.glassTransparency"
    static let shared = GlassStyleStore()

    private(set) var transparency: Int
    private(set) var reduced: Bool
    /// Told each value that is written, for the page's glass.
    @ObservationIgnored var onChange: ((Int) -> Void)?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let isReduced: () -> Bool
    @ObservationIgnored private let scrollViews = NSHashTable<UIScrollView>.weakObjects()
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    var style: GlassStyle { GlassStyle.for(transparency: transparency, reduced: reduced) }
    var barEdge: GlassStyle.BarEdge { GlassStyle.barEdge(transparency: transparency) }
    var needsMigration: Bool { defaults.object(forKey: Self.key) == nil }

    init(
        defaults: UserDefaults = .standard,
        reduced: @escaping () -> Bool = {
            UIAccessibility.isReduceTransparencyEnabled || UIAccessibility.isDarkerSystemColorsEnabled
                || ProcessInfo.processInfo.arguments.contains(LaunchArgument.reduceTransparency)
        },
        center: NotificationCenter = .default
    ) {
        self.defaults = defaults
        isReduced = reduced
        transparency = GlassStyle.clamp(defaults.integer(forKey: Self.key))
        self.reduced = reduced()
        for name in [
            UIAccessibility.reduceTransparencyStatusDidChangeNotification,
            UIAccessibility.darkerSystemColorsStatusDidChangeNotification,
        ] {
            observers.append(
                center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.accessibilityChanged() }
                })
        }
    }

    /// A scroll view under a system bar: its edge follows the value.
    func register(_ view: UIScrollView) {
        scrollViews.add(view)
        edge(view)
    }

    func apply(_ value: Int) {
        let next = GlassStyle.clamp(value)
        guard next != transparency else { return }
        transparency = next
        scrollViews.allObjects.forEach(edge)
    }

    func commit() {
        defaults.set(transparency, forKey: Self.key)
        onChange?(transparency)
    }

    /// The page's value from before this store, taken once; nothing on the page stores the design.
    func migrate(_ value: Int?) {
        guard needsMigration else { return }
        apply(value ?? 0)
        defaults.set(transparency, forKey: Self.key)
    }

    func accessibilityChanged() {
        reduced = isReduced()
    }

    private func edge(_ view: UIScrollView) {
        view.topEdgeEffect.style = barEdge.uiKit
        view.bottomEdgeEffect.style = barEdge.uiKit
    }
}

/// Arguments the UI tests launch Devot with.
public enum LaunchArgument {
    /// A UI test cannot switch the system's Reduce Transparency, so it launches with this instead.
    public static let reduceTransparency = "-DevotReduceTransparency"
}
