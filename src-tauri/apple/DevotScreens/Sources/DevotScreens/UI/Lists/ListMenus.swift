import UIKit

/// The lists' menus (design/phone.md, Note list rows): a row's context menu, the status filter and
/// New Note's long press. A menu never writes itself; it names the write, which the screen sends
/// through the gate once the menu has gone.
@MainActor
enum ListMenus {
    static func row(
        _ note: NoteRow, library: @escaping (@escaping (LibraryContents?) -> Void) -> Void,
        write: @escaping (WriteIntent) -> Void, share: @escaping () -> Void
    ) -> UIMenu {
        let ids = [note.id]
        let pin = UIAction(
            title: note.pinned ? L10n.noteUnpin() : L10n.notePin(),
            image: UIImage(systemName: note.pinned ? "pin.slash" : "pin")
        ) { _ in write(.batch(ids: ids, change: .pinned(!note.pinned))) }
        let statuses = UIMenu(
            title: L10n.phoneStatus(), image: UIImage(systemName: "circle.dashed"), options: .singleSelection,
            children: NoteStatus.allCases.map { status in
                UIAction(
                    title: status.name, image: UIImage(systemName: status.symbol),
                    state: note.status == status.rawValue ? .on : .off
                ) { _ in
                    if note.status != status.rawValue { write(.batch(ids: ids, change: .status(status))) }
                }
            })
        let move = UIMenu(
            title: L10n.phoneMoveTo(), image: UIImage(systemName: "folder"),
            children: [notebooks(selected: note.bookId, library: library) { write(.batch(ids: ids, change: .book($0))) }])
        let tags = UIMenu(
            title: L10n.phoneListTags(), image: UIImage(systemName: "number"),
            children: [
                UIDeferredMenuElement.uncached { provide in
                    library { contents in
                        provide(
                            (contents?.tags ?? []).map { tag in
                                let on = note.tagIds.contains(tag.id)
                                return UIAction(title: tag.name, state: on ? .on : .off) { _ in
                                    write(.batch(ids: ids, change: on ? .removeTag(tag.id) : .putTag(tag.id)))
                                }
                            })
                    }
                }
            ])
        let shareAction = UIAction(title: L10n.phoneActionShare(), image: UIImage(systemName: "square.and.arrow.up")) { _ in
            share()
        }
        let trash = UIAction(title: L10n.noteMoveToTrash(), image: UIImage(systemName: "trash"), attributes: .destructive) {
            _ in write(.batch(ids: ids, change: .trash))
        }
        return UIMenu(children: [
            UIMenu(options: .displayInline, children: [pin, statuses, move, tags]),
            UIMenu(options: .displayInline, children: [shareAction]),
            UIMenu(options: .displayInline, children: [trash]),
        ])
    }

    /// No Notebook, then every notebook indented under its parent, read when the menu opens.
    static func notebooks(
        selected: String?, library: @escaping (@escaping (LibraryContents?) -> Void) -> Void,
        choose: @escaping (String?) -> Void
    ) -> UIMenuElement {
        UIDeferredMenuElement.uncached { provide in
            library { contents in
                let none = UIAction(title: L10n.phoneNoNotebook(), state: selected == nil ? .on : .off) { _ in
                    if selected != nil { choose(nil) }
                }
                let depths = contents?.depths ?? [:]
                let books = (contents?.books ?? []).map { book in
                    let action = UIAction(
                        title: book.name, image: UIImage(systemName: "folder"),
                        state: selected == book.id ? .on : .off
                    ) { _ in
                        if selected != book.id { choose(book.id) }
                    }
                    return Self.indented(action, depths[book.id] ?? 0)
                }
                provide([none] + books)
            }
        }
    }

    /// A nested notebook's name starts further in, as the Library shows it.
    private static func indented(_ action: UIAction, _ depth: Int) -> UIAction {
        guard depth > 0 else { return action }
        action.title = String(repeating: "\u{2003}", count: min(depth, 4)) + action.title
        return action
    }

    static func filter(_ selected: StatusFilter, select: (() -> Void)?, choose: @escaping (StatusFilter) -> Void) -> UIMenu {
        let filters = UIMenu(
            title: L10n.phoneFilterLabel(), options: [.displayInline, .singleSelection],
            children: StatusFilter.allCases.map { filter in
                UIAction(title: filter.name, state: filter == selected ? .on : .off) { _ in choose(filter) }
            })
        guard let select else { return UIMenu(children: [filters]) }
        let selecting = UIAction(title: L10n.phoneListSelect(), image: UIImage(systemName: "checkmark.circle")) { _ in
            select()
        }
        return UIMenu(children: [UIMenu(options: .displayInline, children: [selecting]), filters])
    }

    /// New Note's long press: New Note, New Note in a notebook, or from a template.
    static func compose(
        newNote: @escaping (String?) -> Void, library: @escaping (@escaping (LibraryContents?) -> Void) -> Void,
        fromTemplate: @escaping () -> Void
    ) -> UIMenu {
        let plain = UIAction(title: L10n.noteListNewNote(), image: UIImage(systemName: "square.and.pencil")) { _ in
            newNote(nil)
        }
        let into = UIMenu(
            title: L10n.phoneListNewNoteIn(), image: UIImage(systemName: "folder"),
            children: [notebooks(selected: nil, library: library) { newNote($0) }])
        let template = UIAction(title: L10n.phoneListFromTemplate(), image: UIImage(systemName: "doc.on.doc")) { _ in
            fromTemplate()
        }
        return UIMenu(children: [plain, into, template])
    }
}
