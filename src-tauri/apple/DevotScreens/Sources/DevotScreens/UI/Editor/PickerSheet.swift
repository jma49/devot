import UIKit

/// The editor's pickers (design/motion.md, Sheets): a sheet at medium and large with a grabber, a
/// list that pulls it to large, and a close item. A picker writes only when a row is picked, and
/// the write goes through the gate.
@MainActor
enum PickerSheet {
    static func present(_ content: UIViewController, from presenter: UIViewController) {
        presenter.present(wrap(content), animated: true)
    }

    static func wrap(_ content: UIViewController) -> UINavigationController {
        content.navigationItem.rightBarButtonItem = UIBarButtonItem(
            systemItem: .close, primaryAction: UIAction { [weak content] _ in content?.dismiss(animated: true) })
        let navigation = UINavigationController(rootViewController: content)
        navigation.modalPresentationStyle = .pageSheet
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
            sheet.prefersScrollingExpandsWhenScrolledToEdge = true
        }
        return navigation
    }
}

/// One row of a picker: ticked when it is what the note has now.
struct PickerRow: Equatable {
    let title: String
    let symbol: String?
    let depth: Int
    let on: Bool

    init(title: String, symbol: String? = nil, depth: Int = 0, on: Bool) {
        self.title = title
        self.symbol = symbol
        self.depth = depth
        self.on = on
    }
}

/// A plain list of choices. A single choice closes the sheet once it is picked; a toggle list
/// (tags) stays open, and its rows follow what the note has.
@MainActor
class PickerList: UITableViewController {
    private(set) var rows: [PickerRow] = []
    /// Called with the row's index; a single choice has already closed the sheet.
    var picked: (Int) -> Void = { _ in }
    let closesOnPick: Bool
    var haptics = Haptics()

    init(title: String, rows: [PickerRow], closesOnPick: Bool) {
        self.rows = rows
        self.closesOnPick = closesOnPick
        super.init(style: .insetGrouped)
        navigationItem.title = title
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
    }

    func show(_ next: [PickerRow]) {
        rows = next
        if isViewLoaded { tableView.reloadData() }
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        let row = rows[indexPath.row]
        var content = cell.defaultContentConfiguration()
        content.text = row.title
        content.image = row.symbol.flatMap { UIImage(systemName: $0) }
        content.imageProperties.tintColor = Tokens.Color.phoneTextSecondary
        cell.contentConfiguration = content
        cell.indentationLevel = min(row.depth, 4)
        cell.accessoryType = row.on ? .checkmark : .none
        cell.accessibilityTraits = row.on ? [.button, .selected] : .button
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        pick(indexPath.row)
    }

    func pick(_ index: Int) {
        guard rows.indices.contains(index) else { return }
        haptics.play(.pickerChoice)
        if closesOnPick {
            let picked = picked
            guard let presenting = navigationController?.presentingViewController ?? presentingViewController else {
                return picked(index)
            }
            presenting.dismiss(animated: true) { picked(index) }
        } else {
            picked(index)
        }
    }
}

/// What the pickers write, and where they read the notebooks and tags.
@MainActor
struct PickerContext {
    var write: (WriteIntent) -> Void
    var library: (@escaping (LibraryContents?) -> Void) -> Void
    var haptics: Haptics
}

@MainActor
enum NotePickers {
    static func status(note: EditorNote, context: PickerContext) -> PickerList {
        let statuses = NoteStatus.allCases
        let list = PickerList(
            title: L10n.phoneStatus(),
            rows: statuses.map { PickerRow(title: $0.name, symbol: $0.symbol, on: $0.rawValue == note.status) },
            closesOnPick: true)
        list.haptics = context.haptics
        list.picked = { index in
            let status = statuses[index]
            guard status.rawValue != note.status else { return }
            context.write(.batch(ids: [note.id], change: .status(status)))
        }
        return list
    }

    static func notebook(note: EditorNote, context: PickerContext) -> PickerList {
        let list = PickerList(title: L10n.moveNoteTitle(), rows: [], closesOnPick: true)
        list.haptics = context.haptics
        var choices: [ListMenus.NotebookChoice] = []
        let show = { [weak list] (contents: LibraryContents?) in
            choices = ListMenus.notebookChoices(contents, for: .note(in: note.bookId))
            list?.show(
                choices.map {
                    PickerRow(title: $0.title, symbol: $0.book == nil ? "tray" : "folder", depth: $0.depth, on: $0.on)
                })
        }
        context.library(show)
        list.picked = { index in
            guard choices.indices.contains(index), choices[index].writes else { return }
            context.write(.batch(ids: [note.id], change: .book(choices[index].book)))
        }
        return list
    }

    static func tags(note: EditorNote, context: PickerContext) -> TagPicker {
        let picker = TagPicker(note: note, write: context.write)
        picker.haptics = context.haptics
        context.library { [weak picker] in picker?.show(tags: $0?.tags ?? []) }
        return picker
    }
}

/// Tags: every tag ticked as the note has it, a filter, and a row that makes a tag of the filter's text.
@MainActor
final class TagPicker: PickerList, UISearchResultsUpdating {
    private(set) var note: EditorNote
    private var all: [LibraryTag] = []
    private(set) var shown: [LibraryTag] = []
    private(set) var creating: String?
    private let write: (WriteIntent) -> Void
    let search = UISearchController(searchResultsController: nil)
    private let empty = UILabel()

    init(note: EditorNote, write: @escaping (WriteIntent) -> Void) {
        self.note = note
        self.write = write
        super.init(title: L10n.phoneListTags(), rows: [], closesOnPick: false)
        search.searchResultsUpdater = self
        search.obscuresBackgroundDuringPresentation = false
        search.searchBar.placeholder = L10n.tagPickFilter()
        search.searchBar.autocapitalizationType = .none
        navigationItem.searchController = search
        navigationItem.hidesSearchBarWhenScrolling = false
        picked = { [weak self] in self?.chose($0) }
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        empty.text = L10n.phoneNoTags()
        empty.textColor = Tokens.Color.phoneTextSecondary
        empty.font = UIFont.preferredFont(forTextStyle: .body)
        empty.adjustsFontForContentSizeCategory = true
        empty.numberOfLines = 0
        empty.textAlignment = .center
        refresh()
    }

    func show(tags: [LibraryTag]) {
        all = tags
        refresh()
    }

    /// The editor's facts after a write: the ticks follow them.
    func noteChanged(_ next: EditorNote) {
        guard next.id == note.id else { return }
        note = next
        refresh()
    }

    func updateSearchResults(for searchController: UISearchController) {
        refresh()
    }

    private var query: String {
        (search.searchBar.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func filter(_ text: String) {
        search.searchBar.text = text
        refresh()
    }

    private func refresh() {
        let text = query
        shown = text.isEmpty ? all : all.filter { $0.name.localizedStandardContains(text) }
        let exact = all.contains { $0.name.compare(text, options: [.caseInsensitive]) == .orderedSame }
        creating = text.isEmpty || exact ? nil : text
        var next = creating.map { [PickerRow(title: L10n.tagPickCreate(name: $0), symbol: "plus", on: false)] } ?? []
        next += shown.map { PickerRow(title: $0.name, symbol: "number", on: note.tagIds.contains($0.id)) }
        show(next)
        if isViewLoaded { tableView.backgroundView = next.isEmpty ? empty : nil }
    }

    private func chose(_ index: Int) {
        if let name = creating {
            if index == 0 {
                filter("")
                return write(.addTag(noteId: note.id, name: name))
            }
            return toggle(index - 1)
        }
        toggle(index)
    }

    private func toggle(_ index: Int) {
        guard shown.indices.contains(index) else { return }
        let tag = shown[index]
        let on = note.tagIds.contains(tag.id)
        write(.batch(ids: [note.id], change: on ? .removeTag(tag.id) : .putTag(tag.id)))
    }
}
