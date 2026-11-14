import DevotShareInbox
import Foundation
import UniformTypeIdentifiers

/// What the app that shared handed over, read from the extension's input items: a link, text and
/// image bytes. Anything else is left out.
struct ShareContent: Sendable {
    var title = ""
    var text = ""
    var url: String?
    var images: [Data] = []

    @MainActor
    static func load(_ items: [NSExtensionItem]) async -> ShareContent {
        var content = ShareContent()
        for item in items {
            if content.title.isEmpty, let title = item.attributedTitle?.string { content.title = title }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    if let data = await data(provider, .image) { content.images.append(data) }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let url = await url(provider) {
                        if url.isFileURL {
                            continue
                        } else if content.url == nil, ShareItem.isWebURL(url.absoluteString) {
                            content.url = url.absoluteString
                        }
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let text = await text(provider) { content.add(text) }
                }
            }
            // Safari sends the page's title here, beside the link.
            if let words = item.attributedContentText?.string, !words.isEmpty {
                if content.title.isEmpty, content.url != nil, !words.contains("\n") {
                    content.title = words
                } else {
                    content.add(words)
                }
            }
        }
        return content
    }

    private mutating func add(_ more: String) {
        let trimmed = more.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !text.contains(trimmed) else { return }
        text = text.isEmpty ? trimmed : text + "\n\n" + trimmed
    }

    @MainActor private static func data(_ provider: NSItemProvider, _ type: UTType) async -> Data? {
        await withCheckedContinuation { done in
            _ = provider.loadDataRepresentation(for: type) { data, _ in done.resume(returning: data) }
        }
    }

    @MainActor private static func url(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { done in
            _ = provider.loadObject(ofClass: URL.self) { url, _ in done.resume(returning: url) }
        }
    }

    @MainActor private static func text(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { done in
            _ = provider.loadObject(ofClass: String.self) { text, _ in done.resume(returning: text) }
        }
    }
}
