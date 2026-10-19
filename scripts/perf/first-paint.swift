// Starts a built Devot.app and prints two times and the app's process ID, as
// "<shell ms> <editor ms> <pid>": milliseconds from starting the binary until
// the window's web area has content in the accessibility tree (the empty
// shell: the page's root is empty until React renders), and until the open
// note's editor ("Note body") is in the tree, which is the first editor paint
// the launch budget is judged on. The app keeps running. Used by
// launch-cost.sh.
//
// The editor only shows when a note is open, and a window opens where it was
// left, so the data folder needs a note open once. With --seed the probe
// presses "New Note" once the shell shows and the button is enabled (again
// every second until the editor shows), then waits for the editor; the next
// launch of that data folder restores that note. Without --seed the
// probe waits for the restored note's editor and gives up after 30 s.
// usage: first-paint [--seed] <path to Devot.app>
// The two labels below are the catalog's 'noteList.newNote' and
// 'note.bodyLabel' (a policy test keeps them in step).
import ApplicationServices
import Foundation

let args = CommandLine.arguments
let seed = args.count == 3 && args[1] == "--seed"
guard seed || args.count == 2 else {
  fputs("usage: first-paint [--seed] <path to Devot.app>\n", stderr)
  exit(2)
}
let appPath = args[args.count - 1]
let newNoteLabel = "New Note"
let editorLabel = "Note body"
// DEVOT_PROBE_LABEL waits for another element instead (pnpm bench:app waits for the title field).
let waitLabel = ProcessInfo.processInfo.environment["DEVOT_PROBE_LABEL"] ?? editorLabel
guard AXIsProcessTrusted() else {
  fputs("E_AX_NOT_TRUSTED: allow the terminal in Privacy & Security > Accessibility\n", stderr)
  exit(2)
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
  return result == .success ? value : nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func text(_ element: AXUIElement, _ name: String) -> String? {
  attribute(element, name) as? String
}

/// Whether a web area at or under `element` has content.
func painted(_ element: AXUIElement, depth: Int = 0) -> Bool {
  if depth > 12 { return false }
  if text(element, kAXRoleAttribute) == "AXWebArea" {
    return !children(element).isEmpty
  }
  return children(element).contains { painted($0, depth: depth + 1) }
}

/// The first element at or under `element` named `label` (by its title or
/// description), or nil.
func find(_ element: AXUIElement, _ label: String, depth: Int = 0) -> AXUIElement? {
  if depth > 40 { return nil }
  if text(element, kAXTitleAttribute) == label || text(element, kAXDescriptionAttribute) == label {
    return element
  }
  for child in children(element) {
    if let found = find(child, label, depth: depth + 1) { return found }
  }
  return nil
}

func millis(since start: DispatchTime) -> Double {
  Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e6
}

let process = Process()
process.executableURL = URL(fileURLWithPath: appPath)
  .appendingPathComponent("Contents/MacOS/devot")
process.standardOutput = FileHandle.nullDevice
process.standardError = FileHandle.nullDevice
let start = DispatchTime.now()
do {
  try process.run()
} catch {
  fputs("E_APP_START_FAILED: \(error)\n", stderr)
  exit(1)
}
let app = AXUIElementCreateApplication(process.processIdentifier)
var shellMs: Double?
var lastPress: Double = -1_000
while process.isRunning && millis(since: start) < 30_000 {
  let windows = (attribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  if shellMs == nil, windows.contains(where: { painted($0) }) {
    shellMs = millis(since: start)
  }
  if shellMs != nil {
    if windows.contains(where: { find($0, waitLabel) != nil }) {
      print(String(format: "%.0f %.0f %d", shellMs!, millis(since: start), process.processIdentifier))
      exit(0)
    }
    // The button is disabled until the core is ready, and a press on a
    // disabled button can still report success: press only an enabled one,
    // and press again every second until the editor shows.
    if seed, millis(since: start) - lastPress >= 1_000,
      let button = windows.lazy.compactMap({ find($0, newNoteLabel) }).first,
      (attribute(button, kAXEnabledAttribute) as? Bool) == true
    {
      _ = AXUIElementPerformAction(button, kAXPressAction as CFString)
      lastPress = millis(since: start)
    }
  }
  usleep(10_000)
}
if !process.isRunning {
  fputs("E_APP_EXITED: the app quit before the editor painted\n", stderr)
} else {
  fputs("E_PROBE_TIMEOUT: no editor within 30 s (shell: \(shellMs.map { String(format: "%.0f ms", $0) } ?? "never"))\n", stderr)
  process.terminate()
}
exit(1)
