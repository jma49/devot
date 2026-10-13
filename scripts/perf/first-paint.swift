// Starts a built Devot.app and prints how long its window took to show the
// UI: milliseconds from starting the binary until the window's web area has
// content in the accessibility tree (the page's root is empty until React
// renders the sidebar and the editor pane), then a space and the app's
// process ID. The app keeps running. Used by launch-cost.sh.
// usage: first-paint <path to Devot.app>
import ApplicationServices
import Foundation

let args = CommandLine.arguments
guard args.count == 2 else {
  fputs("usage: first-paint <path to Devot.app>\n", stderr)
  exit(2)
}
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

/// Whether a web area at or under `element` has content.
func painted(_ element: AXUIElement, depth: Int = 0) -> Bool {
  if depth > 12 { return false }
  if (attribute(element, kAXRoleAttribute) as? String) == "AXWebArea" {
    return !children(element).isEmpty
  }
  return children(element).contains { painted($0, depth: depth + 1) }
}

let process = Process()
process.executableURL = URL(fileURLWithPath: args[1])
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
while process.isRunning {
  let windows = (attribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  if windows.contains(where: { painted($0) }) {
    let ms = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e6
    print(String(format: "%.0f %d", ms, process.processIdentifier))
    exit(0)
  }
  usleep(10_000)
}
fputs("E_APP_EXITED: the app quit before it painted\n", stderr)
exit(1)
