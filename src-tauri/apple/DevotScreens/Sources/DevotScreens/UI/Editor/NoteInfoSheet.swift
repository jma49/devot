import SwiftUI
import UIKit

/// What Note Info can do besides showing: each goes through the gate or the editor screen.
struct NoteInfoActions {
    var setDates: (_ createdAt: Double?, _ updatedAt: Double?) -> Void
    var openNote: (_ id: String, _ title: String) -> Void
    var trash: () -> Void
}

/// What Note Info shows, read again while it is up once the note's title, status or tags change.
@MainActor
@Observable
final class NoteInfoModel {
    var info: NoteInfo?
    @ObservationIgnored private let applyChange: (FrontMatter.Field, String) -> Void

    init(info: NoteInfo?, apply: @escaping (FrontMatter.Field, String) -> Void) {
        self.info = info
        applyChange = apply
    }

    var rows: [FrontMatter.Row] {
        guard case .properties(let rows) = info?.frontMatter else { return [] }
        return rows
    }

    func apply(_ difference: FrontMatter.Difference) {
        guard let value = difference.value else { return }
        applyChange(difference.field, value)
    }
}

/// Note Info as a sheet as tall as its content: the counts, the notebook, the two dates (each
/// with a date picker), the front matter, the backlinks and Move to Trash.
struct NoteInfoSheet: View {
    let note: EditorNote
    let notebook: String
    let model: NoteInfoModel
    let actions: NoteInfoActions
    @State private var created: Date
    @State private var updated: Date
    @State private var linksOpen = false

    private var info: NoteInfo? { model.info }

    init(note: EditorNote, notebook: String, model: NoteInfoModel, actions: NoteInfoActions) {
        self.note = note
        self.notebook = notebook
        self.model = model
        self.actions = actions
        _created = State(initialValue: Date(timeIntervalSince1970: note.createdAt / 1000))
        _updated = State(initialValue: Date(timeIntervalSince1970: note.updatedAt / 1000))
    }

    private var figures: [(label: String, value: String)] {
        let number = { (value: Int?) in value.map { $0.formatted() } ?? "" }
        return [
            (L10n.phoneInfoWords(), number(info?.words)),
            (L10n.phoneInfoCharacters(), number(info?.characters)),
            (L10n.phoneInfoReading(), info.map { L10n.phoneInfoMinutes(count: String($0.readingMinutes)) } ?? ""),
            (L10n.phoneInfoRevisions(), number(info?.revisions)),
        ]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Space.space7) {
            Text(L10n.phoneInfoTitle())
                .font(.headline)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
            HStack(alignment: .top) {
                ForEach(figures, id: \.label) { figure in
                    VStack(spacing: Tokens.Space.space2) {
                        Text(figure.value).font(.title3.monospacedDigit()).fontWeight(.semibold)
                        Text(figure.label).font(.caption).foregroundStyle(Color(Tokens.Color.phoneTextSecondary))
                    }
                    .frame(maxWidth: .infinity)
                    .accessibilityElement(children: .combine)
                }
            }
            VStack(spacing: 0) {
                row(L10n.phoneInfoNotebook(), symbol: "folder") { Text(notebook).foregroundStyle(.secondary) }
                Divider()
                row(L10n.phoneInfoCreated(), symbol: "calendar") {
                    DatePicker(
                        L10n.phoneInfoCreated(),
                        selection: Binding(get: { created }, set: { next in pickCreated(next) }),
                        in: ...updated, displayedComponents: [.date, .hourAndMinute]
                    )
                    .labelsHidden()
                }
                Divider()
                row(L10n.phoneInfoModified(), symbol: "clock") {
                    DatePicker(
                        L10n.phoneInfoModified(),
                        selection: Binding(get: { updated }, set: { next in pickUpdated(next) }),
                        in: created...Date.now, displayedComponents: [.date, .hourAndMinute]
                    )
                    .labelsHidden()
                }
            }
            .background(Color(Tokens.Color.phoneCard), in: RoundedRectangle(cornerRadius: Tokens.Radius.phoneSheetCard))
            if let front = info?.frontMatter {
                properties(front)
                    .background(Color(Tokens.Color.phoneCard), in: RoundedRectangle(cornerRadius: Tokens.Radius.phoneSheetCard))
            }
            if let info {
                VStack(spacing: 0) {
                    Button {
                        if !info.backlinks.isEmpty { linksOpen.toggle() }
                    } label: {
                        row(L10n.phoneInfoBacklinks(), symbol: "link") {
                            Text(String(info.backlinks.count)).monospacedDigit().foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                    if linksOpen {
                        ForEach(info.backlinks, id: \.id) { link in
                            Divider()
                            Button {
                                actions.openNote(link.id, link.title)
                            } label: {
                                row(link.title.isEmpty ? L10n.noteUntitled() : link.title, symbol: nil) { EmptyView() }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .background(Color(Tokens.Color.phoneCard), in: RoundedRectangle(cornerRadius: Tokens.Radius.phoneSheetCard))
            }
            Button(role: .destructive) {
                actions.trash()
            } label: {
                Text(L10n.noteMoveToTrash())
                    .frame(maxWidth: .infinity, minHeight: Tokens.Size.phoneTarget)
            }
            .background(Color(Tokens.Color.phoneCard), in: RoundedRectangle(cornerRadius: Tokens.Radius.phoneSheetCard))
        }
        .padding(.horizontal, Tokens.Size.phoneScreenEdge)
        .padding(.vertical, Tokens.Space.space9)
    }

    private func properties(_ front: FrontMatter) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            row(L10n.noteInfoProperties(), symbol: "list.bullet.rectangle") {
                Text(String(model.rows.isEmpty ? 1 : model.rows.count)).monospacedDigit().foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            switch front {
            case .properties(let rows):
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Divider()
                    property(row)
                }
            case .yaml(let yaml):
                Divider()
                Text(yaml)
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Tokens.Space.space7)
                    .padding(.vertical, Tokens.Space.space6)
            }
        }
    }

    private func property(_ row: FrontMatter.Row) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.space2) {
            Text(row.key)
                .font(.footnote)
                .foregroundStyle(Color(Tokens.Color.phoneTextSecondary))
            switch row.value {
            case .text(let text):
                Text(text)
            case .chips(let chips):
                ChipFlow(spacing: Tokens.Space.space3) {
                    ForEach(Array(chips.enumerated()), id: \.offset) { _, chip in
                        Label {
                            Text(chip.name)
                        } icon: {
                            Image(systemName: "tag.fill").foregroundStyle(Color(LibraryScreen.tagColor(chip.color)))
                        }
                        .font(.subheadline)
                        .padding(.horizontal, Tokens.Space.space4)
                        .padding(.vertical, Tokens.Space.space2)
                        .background(Color(Tokens.Color.phoneChip), in: Capsule())
                    }
                }
            }
            if let difference = row.difference {
                HStack(alignment: .firstTextBaseline, spacing: Tokens.Space.space4) {
                    Text(difference.badge)
                        .font(.footnote)
                        .foregroundStyle(Color(Tokens.Color.phoneTextSecondary))
                    Spacer(minLength: Tokens.Space.space4)
                    if difference.value != nil {
                        Button(L10n.previewFrontMatterApply()) { model.apply(difference) }
                            .frame(minHeight: Tokens.Size.phoneTarget)
                            .accessibilityLabel(Self.applyLabel(difference.field))
                            .accessibilityInputLabels([L10n.previewFrontMatterApply(), Self.applyLabel(difference.field)])
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Tokens.Space.space7)
        .padding(.vertical, Tokens.Space.space6)
    }

    static func applyLabel(_ field: FrontMatter.Field) -> String {
        switch field {
        case .title: L10n.previewApplyTitle()
        case .status: L10n.previewApplyStatus()
        case .tags: L10n.previewApplyTags()
        }
    }

    private func row<Trailing: View>(_ label: String, symbol: String?, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: Tokens.Space.space6) {
            if let symbol { Image(systemName: symbol).foregroundStyle(Color(Tokens.Color.phoneTextSecondary)) }
            Text(label)
            Spacer(minLength: Tokens.Space.space4)
            trailing()
        }
        .padding(.horizontal, Tokens.Space.space7)
        .frame(minHeight: Tokens.Size.phoneInfoRow)
        .contentShape(Rectangle())
    }

    private func pickCreated(_ next: Date) {
        created = next
        actions.setDates((next.timeIntervalSince1970 * 1000).rounded(), nil)
    }

    private func pickUpdated(_ next: Date) {
        updated = next
        actions.setDates(nil, (next.timeIntervalSince1970 * 1000).rounded())
    }
}

/// Chips in lines as wide as the card, wrapping onto the next line as text does.
private struct ChipFlow: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let frames = place(subviews, width: width)
        let used = frames.reduce(CGSize.zero) { size, frame in
            CGSize(width: max(size.width, frame.maxX), height: max(size.height, frame.maxY))
        }
        return CGSize(width: proposal.width ?? used.width, height: used.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, frame) in zip(subviews, place(subviews, width: bounds.width)) {
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(frame.size))
        }
    }

    private func place(_ subviews: Subviews, width: CGFloat) -> [CGRect] {
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        for subview in subviews {
            var size = subview.sizeThatFits(.unspecified)
            if size.width > width { size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil)) }
            if x > 0, x + size.width > width {
                x = 0
                y += line + spacing
                line = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing
            line = max(line, size.height)
        }
        return frames
    }
}
