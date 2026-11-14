import Foundation

/// The `devot://capture` link a share becomes; capture_link.rs reads it and fills quick capture.
enum CaptureLink {
  /// The app reads at most 256 KiB of query; the scheme and path fit in what is left over.
  static let maxLength = 256 * 1024

  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

  /// Nil when nothing in the share can be captured. Only an http or https address is kept, a text
  /// that only repeats it is dropped, and a text too long for the link is cut at its end.
  static func make(title: String?, text: String?, url: URL?) -> URL? {
    let title = title.flatMap(kept)
    let source = url.flatMap(webAddress)
    var text = text.flatMap(kept)
    if let body = text, body.trimmingCharacters(in: .whitespacesAndNewlines) == source { text = nil }
    if title == nil, text == nil, source == nil { return nil }
    while true {
      let link = build(title: title, text: text, url: source)
      if link.utf8.count <= maxLength || text == nil { return URL(string: link) }
      let body = text!
      text = body.count > 1 ? String(body.prefix(body.count / 2)) : nil
    }
  }

  private static func kept(_ value: String) -> String? {
    value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : value
  }

  private static func webAddress(_ url: URL) -> String? {
    guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
      url.host != nil
    else { return nil }
    return url.absoluteString
  }

  private static func build(title: String?, text: String?, url: String?) -> String {
    let fields = [("title", title), ("text", text), ("url", url)].compactMap { key, value in
      value.map { "\(key)=\($0.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "")" }
    }
    return "devot://capture?" + fields.joined(separator: "&")
  }
}
