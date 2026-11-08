import UIKit
import WebKit

enum LogLevel: UInt8 {
    case info = 0
    case warn = 1
    case error = 2
}

/// Rust's side of the bridge; tests stand in for it.
protocol RustSide {
    func call(_ request: UInt64, _ json: Data)
    /// A code, then IDs as `key=value`: Rust refuses anything else.
    func log(_ level: LogLevel, _ line: String)
}

/// The native screens of the one window, and the requests they wait on.
@MainActor
final class Screens: SettingsBridge {
    static var shared: Screens?

    /// Set with the launch argument `-DevotScreensOff YES`; the app then keeps the web shell.
    static let killSwitch = "DevotScreensOff"

    let root: ScreensRootController
    var onNotice: ((NoticeKind, [String: JSONValue]) -> Void)?
    private let rust: any RustSide
    private var nextID: UInt64 = 1
    private var waiting: [UInt64: (Outcome) -> Void] = [:]
    /// Calls the screens make while they attach, inside Rust's install, which Rust would refuse;
    /// they go once the install has returned.
    private var attaching = true
    private var held: [(UInt64, Data)] = []
    private var tabModel = TabModel()
    /// Whether the page shows a note in its editor host, so a list taking the web view back asks it to let go.
    private var editorShown = false
    let haptics: Haptics
    let gate: ProGate
    /// New Note's notes, until their screen has gone: whether a change came after the one that made them.
    private var fresh: [String: FreshNote] = [:]
    private var background: NSObjectProtocol?
    private weak var lockSheet: ContentSheetController?
    private let defaults: UserDefaults
    /// A stack a route sets while the app is not in front is not animated.
    var inFront: () -> Bool = { UIApplication.shared.applicationState == .active }
    var now: () -> Date = Date.init

    private struct FreshNote {
        let rev: Double
        var touched = false
    }

    private init(rust: any RustSide, webView: WKWebView, defaults: UserDefaults) {
        self.rust = rust
        self.defaults = defaults
        let root = ScreensRootController(webView: webView)
        self.root = root
        let haptics = Haptics(view: root.tabs.view)
        root.tabs.lists.haptics = haptics
        root.tabs.settings.store.haptics = haptics
        self.haptics = haptics
        let licences = root.tabs.settings.store.licences
        gate = ProGate { [licences] in licences.licence }
        root.log = { [rust] in rust.log($0, $1) }
        root.tabs.onAppear = { [weak self] tab in
            guard let self else { return }
            // A bar item gives no touch-down, so the warning is made ready while a list shows locked.
            if gate.locked() { haptics.prepare(.gateSheet) }
            run(tabModel.appeared(tab))
        }
        root.tabs.onReselect = { [weak self] tab in
            guard let self else { return }
            let effects = tabModel.reselected(tab)
            if !effects.isEmpty { haptics.play(.tabReselect) }
            run(effects)
        }
        root.tabs.settings.bridge = self
        for tab in TabModel.tabs {
            root.tabs.screen(tab)?.hideEditor = { [weak self] done in self?.hideEditor(done) }
        }
        root.onShown = { [weak root] in root?.tabs.settings.start() }
        gate.present = { [weak self] in self?.presentLock($0) }
        gate.dismiss = { [weak self] in Self.close(self?.lockSheet) }
        gate.refresh = { [weak licences] done in
            guard let licences else { return done() }
            licences.read(done: done)
        }
        gate.perform = { [weak self] intent in
            guard let self else { return }
            switch intent {
            case .newNote(let bookId): pushNewNote(bookId)
            default: root.tabs.lists.perform(intent)
            }
        }
        let lists = root.tabs.lists
        lists.gate = gate
        lists.open = { [weak self] id, title in self?.openNote(id, title: title) }
        lists.hideEditor = { [weak self] done in self?.hideEditor(done) }
        lists.untouchedNewNotes = { [weak self] in self?.untouchedNewNotes() ?? [] }
        lists.bridge = self
        root.onLeave = { [weak self] entersBackground in
            guard let self else { return }
            save()
            if entersBackground { defaults.set(false, forKey: Restoration.runningKey) }
        }
        root.onActivate = { [weak self] in self?.defaults.set(true, forKey: Restoration.runningKey) }
        background = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.gate.drop() }
        }
    }

    /// Checks what Rust handed over and attaches the root, or answers nil. Tao's window may not be
    /// up yet: containment needs none.
    static func attach(
        webView: AnyObject, root: AnyObject, rust: any RustSide, defaults: UserDefaults = .standard
    ) -> Screens? {
        if defaults.bool(forKey: killSwitch) {
            rust.log(.info, "I_SCREENS_SWITCHED_OFF")
            return nil
        }
        guard let webView = webView as? WKWebView, let root = root as? UIViewController else {
            rust.log(.warn, "W_SCREENS_INSTALL_REFUSED reason=class")
            return nil
        }
        let screens = Screens(rust: rust, webView: webView, defaults: defaults)
        let crashed = defaults.bool(forKey: Restoration.runningKey)
        defaults.set(true, forKey: Restoration.runningKey)
        UIView.performWithoutAnimation {
            screens.root.attach(to: root)
            screens.restore(crashed: crashed)
        }
        screens.attaching = false
        screens.afterInstall { [weak screens] in screens?.sendHeld() }
        #if DEBUG
            SpikeHarness.startIfAsked(screens: screens, webView: webView, defaults: defaults)
        #endif
        return screens
    }

    var waitingCount: Int { waiting.count }

    func request(_ op: Op, _ args: [String: JSONValue] = [:], done: @escaping (Outcome) -> Void) {
        send({ .request(id: $0, op: op, args: args) }, done: done)
    }

    /// A request Rust answers itself, without the page.
    func direct(_ op: DirectOp, _ args: [String: JSONValue] = [:], done: @escaping (Outcome) -> Void) {
        send({ .direct(id: $0, op: op, args: args) }, done: done)
    }

    func log(_ level: LogLevel, _ line: String) {
        rust.log(level, line)
    }

    private func send(_ message: (UInt64) -> Message, done: @escaping (Outcome) -> Void) {
        let id = nextID
        nextID += 1
        guard let json = try? message(id).json() else {
            done(.failed("E_SCREENS_MESSAGE_INVALID"))
            return
        }
        waiting[id] = done
        if attaching { return held.append((id, json)) }
        sendHeld()
        rust.call(id, json)
    }

    private func sendHeld() {
        let calls = held
        held = []
        for (id, json) in calls { rust.call(id, json) }
    }

    func replied(_ request: UInt64, _ json: Data?) {
        guard let done = waiting.removeValue(forKey: request) else {
            rust.log(.warn, "W_SCREENS_REPLY_UNMATCHED id=\(request)")
            return
        }
        guard let json, case .reply(request, let outcome)? = try? Message(json: json) else {
            rust.log(.warn, "W_SCREENS_REPLY_INVALID id=\(request)")
            done(.failed("E_SCREENS_MESSAGE_INVALID"))
            return
        }
        done(outcome)
    }

    func delivered(_ json: Data?) {
        guard let json, case .notice(let kind, let fields)? = try? Message(json: json) else {
            rust.log(.warn, "W_SCREENS_NOTICE_INVALID")
            return
        }
        if kind == .settingsOpen {
            openSettings(fields)
            return
        }
        if kind == .route {
            guard let route = LinkRoute(fields) else {
                rust.log(.warn, "W_SCREENS_NOTICE_INVALID notice=route")
                return
            }
            follow(route)
            return
        }
        if kind == .syncChanged || kind == .syncPairing {
            root.tabs.settings.store.heard(kind)
            return
        }
        if routeNewNoteNotice(kind, fields) { return }
        if routeEditorNotice(kind, fields) { return }
        guard kind == .tabsState else {
            onNotice?(kind, fields)
            return
        }
        guard let state = TabModel.PageState(fields) else {
            rust.log(.warn, "W_SCREENS_NOTICE_INVALID notice=tabs.state")
            return
        }
        run(tabModel.pageState(tab: state.tab, barHidden: state.barHidden, attention: state.attention))
    }

    /// The page's Pro sheet, Enter License Key, opens License here rather than its own Settings.
    private func openSettings(_ fields: [String: JSONValue]) {
        guard fields["pane"]?.string == "licence" else {
            rust.log(.warn, "W_SCREENS_NOTICE_INVALID notice=settings.open")
            return
        }
        let focusKey = fields["focusKey"]?.bool ?? false
        root.tabs.settings.router.open(.licence(focusKey ? .focusKey : .plain))
    }

    private func run(_ effects: [TabModel.Effect]) {
        for effect in effects {
            switch effect {
            case .show(let tab): ask(.tabsShow, tab, answered: true)
            case .popToRoot(let tab): ask(.tabsPopToRoot, tab, answered: false)
            case .select(let tab): root.tabs.select(tab)
            case .hideBar(let hidden): root.tabs.setTabBarHidden(hidden, animated: true)
            case .badge(let on): root.tabs.setAttention(on)
            }
        }
    }

    /// The notices that drive the editor screen; false for any other kind.
    private func routeEditorNotice(_ kind: NoticeKind, _ fields: [String: JSONValue]) -> Bool {
        switch kind {
        case .navOpenNote:
            guard case .string(let id)? = fields["noteId"], case .string(let title)? = fields["title"] else {
                return invalid(kind)
            }
            openNote(id, title: title)
        case .navBack:
            guard let navigation = shownNavigation, navigation.topViewController is EditorScreen,
                navigation.transitionCoordinator == nil
            else { return true }
            navigation.popViewController(animated: true)
        case .editorReady:
            guard case .string(let id)? = fields["noteId"] else { return invalid(kind) }
            (root.host.holder as? EditorScreen)?.ready(id)
        case .editorMode:
            guard case .string(let id)? = fields["noteId"], case .string(let name)? = fields["mode"],
                let mode = NoteMode(rawValue: name)
            else { return invalid(kind) }
            for screen in editorScreens where screen.noteId == id { screen.showMode(mode) }
        case .editorTitle:
            guard case .string(let id)? = fields["id"], case .string(let title)? = fields["title"] else {
                return invalid(kind)
            }
            for screen in editorScreens where screen.noteId == id { screen.retitle(title) }
        case .editorScroll:
            guard case .bool(let visible)? = fields["titleVisible"] else { return invalid(kind) }
            (root.host.holder as? EditorScreen)?.titleVisible(visible)
        case .editorNote:
            guard let note = EditorNote(fields) else { return invalid(kind) }
            for screen in editorScreens where screen.noteId == note.id { screen.showNote(note) }
        case .editorPicker:
            guard case .string(let id)? = fields["noteId"], let name = fields["picker"]?.string,
                let picker = EditorScreen.Picker(rawValue: name)
            else { return invalid(kind) }
            guard let screen = root.host.holder as? EditorScreen, screen.noteId == id else { return true }
            screen.showPicker(picker)
        case .editorHaptic:
            guard let name = fields["kind"]?.string else { return invalid(kind) }
            haptics.play(page: name)
        default:
            return false
        }
        return true
    }

    /// New Note, the changes that mark a new note touched, and Rust's word that the licence changed.
    private func routeNewNoteNotice(_ kind: NoticeKind, _ fields: [String: JSONValue]) -> Bool {
        switch kind {
        case .noteNew:
            if let bookId = fields["bookId"], bookId.string == nil { return invalid(kind) }
            gate.require(.newNote(bookId: fields["bookId"]?.string))
            return true
        case .licenceChanged:
            root.tabs.settings.store.licences.read { [weak self] in self?.gate.licenceChanged() }
            return true
        case .notesChanged:
            guard let rev = fields["rev"]?.number, let ids = fields["ids"]?.array else { return invalid(kind) }
            let named = ids.compactMap(\.string)
            for id in named where (fresh[id]?.rev ?? .infinity) < rev {
                fresh[id]?.touched = true
            }
            root.tabs.lists.notesChanged(rev: rev, ids: named, all: fields["all"]?.bool ?? false)
            return false
        case .booksChanged, .tagsChanged, .savedSearchesChanged:
            root.tabs.lists.libraryChanged()
            return false
        default:
            return false
        }
    }

    private func invalid(_ kind: NoticeKind) -> Bool {
        rust.log(.warn, "W_SCREENS_NOTICE_INVALID notice=\(kind.rawValue)")
        return true
    }

    private var shownNavigation: UINavigationController? {
        root.tabs.shownNavigation
    }

    private var editorScreens: [EditorScreen] {
        root.tabs.navigations.values.flatMap(\.viewControllers).compactMap { $0 as? EditorScreen }
    }

    /// Pushed at once on the shown tab; a second tap while a push runs, or on the note already shown, does nothing.
    private func openNote(_ id: String, title: String) {
        guard let navigation = shownNavigation, navigation.transitionCoordinator == nil,
            (navigation.topViewController as? EditorScreen)?.noteId != id
        else { return }
        let screen = EditorScreen(
            noteId: id, title: title, tab: tabModel.selected, host: root.host, actions: editorActions)
        navigation.pushViewController(screen, animated: true)
    }

    /// Pushed in the same turn as the tap, under a cover, while the page makes the note.
    private func pushNewNote(_ bookId: String?) {
        guard let navigation = shownNavigation, navigation.transitionCoordinator == nil,
            !(navigation.topViewController is EditorScreen)
        else { return }
        let screen = EditorScreen(newNoteIn: bookId, tab: tabModel.selected, host: root.host, actions: editorActions)
        navigation.pushViewController(screen, animated: true)
        request(.noteCreate, screen.bookId.map { ["bookId": .string($0)] } ?? [:]) { [weak self] outcome in
            guard let self else { return }
            switch outcome {
            case .ok(let made):
                guard let id = made["id"]?.string else { return refusedCreate(screen, code: "E_SCREENS_MESSAGE_INVALID") }
                fresh[id] = FreshNote(rev: made["rev"]?.number ?? 0)
                screen.created(id)
                if let stack = screen.navigationController?.viewControllers, let at = stack.firstIndex(of: screen), at > 0 {
                    (stack[at - 1] as? NoteListScreen)?.created(id)
                }
                discardLeftNewNotes()
            case .failed(let code):
                refusedCreate(screen, code: code)
            }
        }
    }

    /// Nothing was stored, and the cover never came down: the screen pops, then the gate's surface.
    private func refusedCreate(_ screen: EditorScreen, code: String) {
        let locked = code == ProGate.required || code == ProGate.unreadable
        rust.log(.warn, locked ? "W_PHONE_WRITE_LOCKED op=note.create code=\(code)" : "W_PHONE_NEW_NOTE_FAILED code=\(code)")
        guard let navigation = screen.navigationController else { return }
        afterTransition(navigation) { [weak self] in
            if navigation.topViewController === screen {
                navigation.popViewController(animated: true)
            } else {
                navigation.viewControllers.removeAll { $0 === screen }
            }
            Self.afterTransition(navigation) { if locked { self?.gate.refused(code: code) } }
        }
    }

    private func afterTransition(_ navigation: UINavigationController, _ then: @escaping () -> Void) {
        Self.afterTransition(navigation, then)
    }

    private static func afterTransition(_ navigation: UINavigationController, _ then: @escaping () -> Void) {
        guard let coordinator = navigation.transitionCoordinator,
            coordinator.animate(alongsideTransition: nil, completion: { _ in then() })
        else { return then() }
    }

    /// A new note whose screen is in no stack any more, with nothing changed in it, goes; the page
    /// checks again that it is still as made. A back swipe turned back keeps the screen, and the note.
    private func discardLeftNewNotes() {
        let shown = Set(editorScreens.compactMap(\.noteId))
        for (id, note) in fresh where !shown.contains(id) {
            fresh[id] = nil
            guard !note.touched else { continue }
            request(.noteDiscard, ["noteId": .string(id)]) { [weak self] outcome in
                if case .failed(let code) = outcome { self?.rust.log(.warn, "W_PHONE_DISCARD_FAILED code=\(code)") }
            }
        }
    }

    /// The new notes a native list drops before the pop that leaves them draws a frame; the page
    /// still decides, on `note.discard`, whether each one goes.
    private func untouchedNewNotes() -> [String] {
        let shown = Set(editorScreens.compactMap(\.noteId))
        return fresh.filter { !$0.value.touched && !shown.contains($0.key) }.map(\.key)
    }

    /// One sheet per locked tap, with the warning played in the same turn as it rises.
    private func presentLock(_ surface: LockSurface) {
        let store = root.tabs.settings.store
        // Only this sheet: a purchase that ends after a swipe-down must not close a later sheet.
        weak var shown: ContentSheetController?
        let close = { Self.close(shown) }
        let openLicence = { [weak self] (focusKey: Bool) in
            close()
            self?.root.tabs.settings.router.open(.licence(focusKey ? .focusKey : .plain))
        }
        let sheet: ContentSheetController
        switch surface {
        case .purchase(let heading):
            if store.products.isEmpty { store.loadProducts() }
            sheet = ContentSheetController(
                PurchaseSheet(
                    store: store, close: close, enterKey: { openLicence(true) }, gateHeading: heading,
                    unlocked: { [weak self] in self?.gate.unlocked() }))
        case .pro(let kind):
            sheet = ContentSheetController(
                ProSheet(
                    kind: kind, store: store,
                    actions: ProSheetActions(
                        openLicence: openLicence, unlocked: { [weak self] in self?.gate.unlocked() }, close: close)))
        }
        shown = sheet
        lockSheet = sheet
        sheet.onDismiss = { [weak self] in self?.gate.dismissed() }
        sheet.view.accessibilityViewIsModal = true
        let presenter = root.tabs.presentedViewController ?? root.tabs
        haptics.play(.gateSheet)
        presenter.present(sheet, animated: true)
    }

    private static func close(_ sheet: ContentSheetController?) {
        guard let sheet, sheet.presentingViewController != nil, !sheet.isBeingDismissed else { return }
        sheet.dismiss(animated: true)
    }

    private var editorActions: EditorActions {
        EditorActions(
            show: { [weak self] id, focusBody in
                self?.editorShown = true
                var args: [String: JSONValue] = ["noteId": .string(id)]
                if focusBody { args["focus"] = .string("body") }
                self?.askEditor(.editorShow, args)
            },
            setMode: { [weak self] mode in self?.askEditor(.editorSetMode, ["mode": .string(mode.rawValue)]) },
            appeared: { [weak self] tab in
                guard let self else { return }
                run(tabModel.appeared(tab))
            },
            focus: { [weak self] screen in
                self?.request(.editorFocus) { outcome in
                    guard case .ok(let result) = outcome, result["focused"]?.bool == true else {
                        return screen.focusRefused()
                    }
                }
            },
            left: { [weak self] _ in self?.discardLeftNewNotes() },
            page: { [weak self] op, args, done in
                guard let self else { return done(.failed("E_SCREENS_UNAVAILABLE")) }
                request(op, args) { [weak self] outcome in
                    if case .failed(let code) = outcome {
                        self?.rust.log(.warn, "W_SCREENS_EDITOR_FAILED op=\(op.rawValue) code=\(code)")
                    }
                    done(outcome)
                }
            },
            write: { [weak self] intent in self?.gate.require(intent) },
            ask: { [weak self] intent in self?.root.tabs.lists.ask(intent) },
            locked: { [weak self] in self?.gate.locked() ?? false },
            library: { [weak self] done in
                guard let lists = self?.root.tabs.lists else { return done(nil) }
                if let library = lists.library { return done(library) }
                lists.readLibrary()
                done(nil)
            },
            open: { [weak self] id, title in self?.openNote(id, title: title) },
            text: { [weak self] id, done in self?.root.tabs.lists.text(id) { _, markdown in done(markdown) } },
            haptics: haptics)
    }

    private func hideEditor(_ done: @escaping () -> Void) {
        // Before the hide, so the list the page paints for it has no row for the note.
        discardLeftNewNotes()
        guard editorShown else { return done() }
        editorShown = false
        askEditor(.editorHide, done: done)
    }

    private func askEditor(_ op: Op, _ args: [String: JSONValue] = [:], done: (() -> Void)? = nil) {
        request(op, args) { [weak self] outcome in
            if case .failed(let code) = outcome {
                self?.rust.log(.warn, "W_SCREENS_EDITOR_FAILED op=\(op.rawValue) code=\(code)")
            }
            done?()
        }
    }

    // MARK: Routes and restoration (docs/specs/iphone-screens.md)

    private func follow(_ route: LinkRoute) {
        switch route {
        case .stack(let tab, let screens):
            show(tab, screens)
        case .today:
            request(.noteToday) { [weak self] outcome in
                guard let self else { return }
                switch outcome {
                case .ok(let today):
                    guard let id = today["id"]?.string else {
                        return rust.log(.warn, "W_SCREENS_TODAY_FAILED code=E_SCREENS_MESSAGE_INVALID")
                    }
                    show(.notes, [.editor(noteId: id)])
                case .failed(let code) where code == ProGate.required || code == ProGate.unreadable:
                    rust.log(.warn, "W_PHONE_WRITE_LOCKED op=note.today code=\(code)")
                    gate.refused(code: code)
                case .failed(let code):
                    rust.log(.warn, "W_SCREENS_TODAY_FAILED code=\(code)")
                }
            }
        case .licence(let prefill):
            root.tabs.settings.router.open(.licence(prefill.map(LicenceEntry.prefill) ?? .plain))
        case .mode(let mode):
            guard shownNavigation?.topViewController is EditorScreen else { return }
            askEditor(.editorSetMode, ["mode": .string(mode.rawValue)])
        }
    }

    /// The tab, with these screens above its root; a note no longer there ends the stack below it.
    private func show(_ tab: Tab, _ screens: [ScreenRoute]) {
        liveTitles(of: screens.compactMap(\.editorId)) { [weak self] titles in
            guard let self, let titles else { return }
            let kept = Restoration.cut(screens, live: Set(titles.keys))
            if kept.count < screens.count { rust.log(.info, "I_SCREENS_ROUTE_NOTE_GONE") }
            guard let navigation = root.tabs.navigations[tab], let first = navigation.viewControllers.first else { return }
            let animated = inFront()
            if let shown = root.tabs.presentedViewController, shown !== lockSheet {
                shown.dismiss(animated: animated)
            }
            var stack = [first]
            for (at, screen) in kept.enumerated() {
                let current = navigation.viewControllers.dropFirst(at + 1).first
                if let current, descriptor(current) == screen {
                    stack.append(current)
                } else if let made = controller(screen, tab: tab, titles: titles) {
                    stack.append(made)
                } else {
                    break
                }
            }
            root.tabs.select(tab)
            setStack(navigation, stack, animated: animated)
        }
    }

    /// The titles of those of `ids` that are live notes; nil when the read failed.
    private func liveTitles(of ids: [String], done: @escaping ([String: String]?) -> Void) {
        guard !ids.isEmpty else { return done([:]) }
        direct(.listsTitles, ["ids": .array(ids.map(JSONValue.string))]) { [weak self] outcome in
            guard case .ok(.array(let rows)) = outcome else {
                if case .failed(let code) = outcome { self?.rust.log(.warn, "W_SCREENS_TITLES_FAILED code=\(code)") }
                return done(nil)
            }
            var titles: [String: String] = [:]
            for row in rows {
                if let id = row["id"]?.string, let title = row["title"]?.string { titles[id] = title }
            }
            done(titles)
        }
    }

    /// Whether the last stack a route or a launch set moved, for the tests.
    private(set) var lastStackAnimated: Bool?

    private func setStack(_ navigation: UINavigationController, _ stack: [UIViewController], animated: Bool) {
        guard navigation.viewControllers != stack else { return }
        lastStackAnimated = animated
        navigation.setViewControllers(stack, animated: animated)
    }

    /// A screen of the tab's own kind: Settings pages under Settings, lists and notes elsewhere.
    private func controller(_ screen: ScreenRoute, tab: Tab, titles: [String: String]) -> UIViewController? {
        let lists = root.tabs.lists
        switch screen {
        case .pane(let name):
            guard tab == .settings else { return nil }
            return SettingsPage(pane: name).map(root.tabs.settings.router.make)
        case _ where tab == .settings: return nil
        case .list(let view, let status): return LibraryScreen.list(view, status, tab: tab, context: lists)
        case .trash: return TrashScreen(tab: tab, context: lists)
        case .editor(let id):
            return EditorScreen(noteId: id, title: titles[id] ?? "", tab: tab, host: root.host, actions: editorActions)
        }
    }

    /// What a controller in a stack is, for the record; nil for one a launch does not rebuild, such
    /// as a new note's screen before its note exists or while nothing has changed in it.
    private func descriptor(_ controller: UIViewController) -> ScreenRoute? {
        switch controller {
        case let editor as EditorScreen:
            guard let id = editor.noteId, !(editor.isNew && fresh[id]?.touched == false) else { return nil }
            return .editor(noteId: id)
        case let list as NoteListScreen: return .list(list.source.view, list.openedStatus)
        case is TrashScreen: return .trash
        default: return controller.restorationIdentifier.map(ScreenRoute.pane)
        }
    }

    /// Writes the record a launch restores from: kinds and IDs only.
    func save() {
        var record = Restoration(tab: root.tabs.selected ?? .library, savedAt: now())
        for tab in Restoration.tabs {
            guard let navigation = root.tabs.navigations[tab] else { continue }
            var stack: [ScreenRoute] = []
            for controller in navigation.viewControllers.dropFirst() {
                guard let screen = descriptor(controller) else { break }
                stack.append(screen)
            }
            record.stacks[tab] = stack
            let top = navigation.viewControllers[min(stack.count, navigation.viewControllers.count - 1)]
            if let list = top as? NoteListScreen, let id = list.firstVisibleId { record.firstVisible[tab] = id }
        }
        for screen in editorScreens where screen.isNew {
            guard let id = screen.noteId, fresh[id]?.touched == false else { continue }
            record.newNotes.append(Restoration.NewNote(id: id, bookId: screen.bookId))
        }
        defaults.set(record.encoded(), forKey: Restoration.key)
    }

    /// Rebuilds the last stacks before the first frame, without animation; after a crash or eight
    /// hours every tab starts at its root. The editors whose notes have gone are cut once Rust says
    /// which, and the untouched new notes of the last launch are discarded.
    private func restore(crashed: Bool) {
        let record = Restoration.decode(defaults.data(forKey: Restoration.key))
        let earlier = record?.newNotes ?? []
        guard let record = record?.restorable(at: now(), crashed: crashed) else {
            if crashed { rust.log(.info, "I_SCREENS_RESTORE_SKIPPED reason=crash") }
            return afterInstall { [weak self] in self?.discard(earlier) }
        }
        for tab in Restoration.tabs {
            guard let navigation = root.tabs.navigations[tab], let first = navigation.viewControllers.first else { continue }
            let made = (record.stacks[tab] ?? []).compactMap { controller($0, tab: tab, titles: [:]) }
            if !made.isEmpty { setStack(navigation, [first] + made, animated: false) }
            if let id = record.firstVisible[tab], let list = navigation.topViewController as? NoteListScreen {
                list.restoreFirstVisible(id)
            }
        }
        if TabModel.tabs.contains(record.tab) { root.tabs.select(record.tab) }
        afterInstall { [weak self] in
            guard let self else { return }
            discard(earlier)
            let editors = editorScreens
            liveTitles(of: editors.compactMap(\.noteId)) { [weak self] titles in
                guard let self, let titles else { return }
                for screen in editors {
                    guard let id = screen.noteId else { continue }
                    if let title = titles[id] { screen.retitle(title) } else { cut(screen) }
                }
            }
        }
    }

    /// Rust takes requests only once the install that runs this has returned.
    private func afterInstall(_ then: @escaping @MainActor () -> Void) {
        DispatchQueue.main.async { MainActor.assumeIsolated { then() } }
    }

    private func discard(_ notes: [Restoration.NewNote]) {
        for note in notes {
            let made: JSONValue = .object(["bookId": note.bookId.map(JSONValue.string) ?? .null])
            request(.noteDiscard, ["noteId": .string(note.id), "made": made]) { [weak self] outcome in
                if case .failed(let code) = outcome { self?.rust.log(.warn, "W_PHONE_DISCARD_FAILED code=\(code)") }
            }
        }
    }

    private func cut(_ screen: EditorScreen) {
        guard let navigation = screen.navigationController,
            let at = navigation.viewControllers.firstIndex(of: screen)
        else { return }
        rust.log(.info, "I_SCREENS_RESTORE_NOTE_GONE")
        setStack(navigation, Array(navigation.viewControllers[..<at]), animated: false)
    }

    private func ask(_ op: Op, _ tab: Tab, answered: Bool) {
        request(op, ["tab": .string(tab.rawValue)]) { [weak self] outcome in
            guard let self else { return }
            if answered { tabModel.showAnswered() }
            if case .failed(let code) = outcome {
                rust.log(.warn, "W_SCREENS_TAB_FAILED op=\(op.rawValue) code=\(code)")
            }
        }
    }
}
