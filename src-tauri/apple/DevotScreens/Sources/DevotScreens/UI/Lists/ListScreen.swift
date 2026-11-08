import UIKit

/// What every native list screen does around its collection view: the system bar with a large
/// title on a tab's root, a row that pushed deselecting alongside the pop (and selected again
/// when the pop is cancelled), and the page asked to let a note go once the list shows again.
class ListScreen: UIViewController {
    let context: ListContext
    let listTab: Tab
    let isRoot: Bool
    var onAppear: (Tab) -> Void = { _ in }
    private(set) var collection: UICollectionView!

    init(title: String, tab: Tab, context: ListContext, isRoot: Bool) {
        self.context = context
        self.listTab = tab
        self.isRoot = isRoot
        super.init(nibName: nil, bundle: nil)
        navigationItem.title = title
        navigationItem.largeTitleDisplayMode = isRoot ? .always : .never
        navigationItem.backButtonDisplayMode = .minimal
    }

    required init?(coder: NSCoder) { nil }

    func makeLayout() -> UICollectionViewLayout {
        UICollectionViewCompositionalLayout.list(using: UICollectionLayoutListConfiguration(appearance: .plain))
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Tokens.Color.phoneBackground
        let collection = UICollectionView(frame: view.bounds, collectionViewLayout: makeLayout())
        collection.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        collection.backgroundColor = Tokens.Color.phoneBackground
        collection.delegate = self as? UICollectionViewDelegate
        collection.allowsMultipleSelectionDuringEditing = true
        view.addSubview(collection)
        self.collection = collection
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        onAppear(listTab)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
        navigationController?.interactiveContentPopGestureRecognizer?.isEnabled = false
        guard !collection.isEditing, let selected = collection.indexPathsForSelectedItems, !selected.isEmpty else { return }
        guard let coordinator = transitionCoordinator else {
            for path in selected { collection.deselectItem(at: path, animated: animated) }
            return
        }
        coordinator.animate { [weak self] _ in
            for path in selected { self?.collection.deselectItem(at: path, animated: true) }
        } completion: { [weak self] context in
            guard context.isCancelled else { return }
            for path in selected { self?.collection.selectItem(at: path, animated: false, scrollPosition: []) }
        }
    }

    /// As a web tab does when it takes the web view: the note the page showed is let go.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        context.hideEditor {}
    }
}
