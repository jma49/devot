import SwiftUI
import UIKit

/// Devot's own glass at a Glass Transparency: -100 is solid, 0 the design, 100 the clearest.
enum GlassStyle: Equatable {
    /// No glass: the opaque glass colour.
    case solid
    /// The regular glass, tinted towards the opaque glass colour by `tint`.
    case regular(tint: CGFloat)
    /// The clear glass, with a tint that thins to nothing at 100.
    case clear(tint: CGFloat)

    static let range = -100...100
    static let step = 5

    static func `for`(transparency t: Int, reduced: Bool = false) -> GlassStyle {
        if reduced || t <= range.lowerBound { return .solid }
        if t <= 0 { return .regular(tint: CGFloat(-t) / 100) }
        return .clear(tint: CGFloat(max(0, range.upperBound - t)) / 400)
    }

    /// The edge the system bars blur their content to: only a value below 0 firms it.
    enum BarEdge: Equatable {
        case automatic
        case hard

        @MainActor var uiKit: UIScrollEdgeEffect.Style { self == .hard ? .hard : .automatic }
        var swiftUI: ScrollEdgeEffectStyle { self == .hard ? .hard : .automatic }
    }

    static func barEdge(transparency t: Int) -> BarEdge {
        t < 0 ? .hard : .automatic
    }

    /// A stored value on the slider's range and steps.
    static func clamp(_ t: Int) -> Int {
        let stepped = Int((Double(t) / Double(step)).rounded()) * step
        return min(range.upperBound, max(range.lowerBound, stepped))
    }

    @MainActor var glass: Glass? {
        let opaque = Color(Tokens.Color.phoneGlassOpaque)
        switch self {
        case .solid: return nil
        case .regular(let tint): return tint > 0 ? .regular.tint(opaque.opacity(tint)) : .regular
        case .clear(let tint): return tint > 0 ? .clear.tint(opaque.opacity(tint)) : .clear
        }
    }
}

extension View {
    /// Devot's glass in `style`, or the opaque glass colour where it is solid.
    @ViewBuilder func devotGlass(_ style: GlassStyle, in shape: some Shape) -> some View {
        if let glass = style.glass {
            glassEffect(glass, in: shape)
        } else {
            background(Color(Tokens.Color.phoneGlassOpaque), in: shape)
        }
    }
}
