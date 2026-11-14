// CaptureLink.make against tests/fixtures/capture-links.json, whose links capture_link.rs reads;
// tests/scripts/macos-share-extension.test.ts runs it.
import Foundation

struct Share: Decodable {
  let shared: [String: String]
  let link: String?
}

struct Fixture: Decodable {
  let shares: [Share]
}

let path = CommandLine.arguments[1]
let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
var failures = 0
for share in fixture.shares {
  let made = CaptureLink.make(
    title: share.shared["title"], text: share.shared["text"],
    url: share.shared["url"].flatMap(URL.init(string:)))
  if made?.absoluteString != share.link {
    failures += 1
    print("E_LINK_MISMATCH \(share.shared) gave \(made?.absoluteString ?? "nil")")
  }
}

let long = String(repeating: "\u{1F600}", count: 100_000)
if let made = CaptureLink.make(title: nil, text: long, url: nil) {
  if made.absoluteString.utf8.count > CaptureLink.maxLength {
    failures += 1
    print("E_LINK_TOO_LONG \(made.absoluteString.utf8.count)")
  }
} else {
  failures += 1
  print("E_LINK_LONG_DROPPED")
}

if failures > 0 { exit(1) }
print("CaptureLink: all \(fixture.shares.count + 1) cases pass")
