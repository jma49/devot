import SwiftUI
import UIKit

/// What Note Info can do besides showing: each goes through the gate or the editor screen.
struct NoteInfoActions {
    var setDates: (_ createdAt: Double?, _ updatedAt: Double?) -> Void
    var openNote: (_ id: String, _ title: String) -> Void
    var trash: () -> Void
}

/// Note Info as a sheet as tall as its content: the counts, the notebook, the two dates (each
/// with a date picker), the backlinks and Move to Trash.
struct NoteInfoSheet: View {
    let note: EditorNote
    let notebook: String
    let info: NoteInfo?
    let actions: NoteInfoActions
    @State private var created: Date
    @State private var updated: Date
    @State private var linksOpen = false

    init(note: EditorNote, notebook: String, info: NoteInfo?, actions: NoteInfoActions) {
        self.note = note
        self.notebook = notebook
        self.info = info
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
