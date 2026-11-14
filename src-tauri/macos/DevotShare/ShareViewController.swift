import AppKit
import UniformTypeIdentifiers

/// The Share menu's Devot item. It shows nothing itself: it turns the share into a capture link and
/// opens it, so Devot's quick capture window is where the owner edits, saves or cancels it.
@objc(DevotShareViewController)
final class ShareViewController: NSViewController {
  private var sharedTitle: String?
  private var texts: [String] = []
  private var url: URL?

  override func loadView() {
    view = NSView(frame: .zero)
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
    let group = DispatchGroup()
    for item in items {
      if sharedTitle == nil, let title = item.attributedTitle?.string { sharedTitle = title }
      if let text = item.attributedContentText?.string { texts.append(text) }
      for provider in item.attachments ?? [] { read(provider, in: group) }
    }
    group.notify(queue: .main) { [self] in finish() }
  }

  private func read(_ provider: NSItemProvider, in group: DispatchGroup) {
    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
      group.enter()
      _ = provider.loadObject(ofClass: NSURL.self) { [self] object, _ in
        let url = (object as? NSURL).map { $0 as URL }
        DispatchQueue.main.async { [self] in
          if self.url == nil, let url, url.scheme == "http" || url.scheme == "https" { self.url = url }
          group.leave()
        }
      }
    } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
      group.enter()
      _ = provider.loadObject(ofClass: NSString.self) { [self] object, _ in
        let text = (object as? NSString).map { $0 as String }
        DispatchQueue.main.async { [self] in
          if let text { texts.append(text) }
          group.leave()
        }
      }
    }
  }

  private func finish() {
    let text = texts.isEmpty ? nil : texts.joined(separator: "\n\n")
    if let link = CaptureLink.make(title: sharedTitle, text: text, url: url) {
      NSWorkspace.shared.open(link)
      extensionContext?.completeRequest(returningItems: nil)
    } else {
      extensionContext?.cancelRequest(withError: NSError(domain: "E_SHARE_NOTHING", code: 1))
    }
  }
}
