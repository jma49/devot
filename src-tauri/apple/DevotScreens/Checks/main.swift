// L10n.fill against the page's `format` cases (src/renderer/src/i18n/i18n.test.ts); CI runs it.
import Foundation

var failures = 0

@MainActor func expectFill(_ template: String, _ values: [String: String], _ expected: String) {
  let actual = L10n.fill(template, values)
  if actual != expected {
    failures += 1
    print("E_FILL_MISMATCH \(template.debugDescription) gave \(actual.debugDescription)")
  }
}

expectFill("{filter} in {book}", ["filter": "Sync", "book": "Work"], "Sync in Work")
expectFill("In {view}", ["view": "Make $$ $& $` $'"], "In Make $$ $& $` $'")
expectFill("{filter} in {book}", ["filter": "{book}", "book": "Work"], "{book} in Work")
expectFill("{a} and {b}", ["a": "1"], "1 and {b}")
expectFill("{{date}} for {name}", ["name": "Ada"], "{{date}} for Ada")
expectFill("{{date}}", ["date": "today"], "{today}")
expectFill("{} {a b} {\u{e9}} {a", ["a": "1", "a b": "2", "\u{e9}": "3"], "{} {a b} {\u{e9}} {a")
expectFill("{step_2}", ["step_2": "two"], "two")

if failures > 0 { exit(1) }
print("L10n.fill: all cases pass")
