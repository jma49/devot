import CoreGraphics

/// How a tab lays out its stack at its width (docs/specs/iphone-screens.md, Columns): one stack, as
/// on an iPhone; its lists beside the note on top; or, on the Library, its root, the list it opened
/// and the note side by side.
enum ColumnLayout: Int, Equatable, Sendable {
    case one = 1
    case two
    case three

    struct Widths: Equatable, Sendable {
        var twoColumns: CGFloat
        var threeColumns: CGFloat
        var sidebar: CGFloat
        var list: CGFloat
    }

    static func fitting(width: CGFloat, regular: Bool, allowsThree: Bool, widths: Widths) -> ColumnLayout {
        guard regular, width >= widths.twoColumns else { return .one }
        return allowsThree && width >= widths.threeColumns ? .three : .two
    }

    /// The stack in this layout's columns, in order: the notes on top go to the last column, and
    /// with three columns the root has the first to itself.
    func split<T>(_ stack: [T], isNote: (T) -> Bool) -> [[T]] {
        let notesFrom = stack.lastIndex { !isNote($0) }.map { $0 + 1 } ?? 0
        let lists = Array(stack[..<notesFrom])
        let notes = Array(stack[notesFrom...])
        switch self {
        case .one: return [stack]
        case .two: return [lists, notes]
        case .three: return [Array(lists.prefix(1)), Array(lists.dropFirst()), notes]
        }
    }

    /// Each column's width: the leading ones fixed, the note's taking what they leave.
    func columnWidths(total: CGFloat, widths: Widths) -> [CGFloat] {
        switch self {
        case .one: return [total]
        case .two: return [widths.list, max(0, total - widths.list)]
        case .three: return [widths.sidebar, widths.list, max(0, total - widths.sidebar - widths.list)]
        }
    }
}
