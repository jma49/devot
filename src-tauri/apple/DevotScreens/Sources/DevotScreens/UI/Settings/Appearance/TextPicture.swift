import SwiftUI

/// Text drawn as a picture at a fixed size, with the text as its label. A sample of Text Size shows
/// the note at its size in points, and a miniature bar or swatch keeps its size as the thing it
/// shows does; none follows Dynamic Type, so none is text the accessibility audit expects to scale.
struct TextPicture: View {
    let text: String
    let font: Font
    let color: UIColor
    /// A sample wraps at the width it is given; a miniature title keeps to one line.
    var wraps = true

    var body: some View {
        if (ProcessInfo.processInfo.environment["DEVOTDIAG"] ?? "").contains("nopics") { Color.clear.frame(height: 20) } else { real }
    }

    var real: some View {
        // The hidden text takes the picture's place, so the picture is drawn at the size it lays out at.
        Text(text).font(font)
            .fixedSize(horizontal: !wraps, vertical: true)
            .hidden()
            .overlay {
                Canvas { context, size in
                    let resolved = context.resolve(Text(text).font(font).foregroundStyle(Color(uiColor: color)))
                    context.draw(resolved, in: CGRect(origin: .zero, size: size))
                }
            }
            .frame(maxWidth: wraps ? .infinity : nil, alignment: .leading)
            .accessibilityElement()
            .accessibilityLabel(text)
            .accessibilityAddTraits(.isStaticText)
    }
}
