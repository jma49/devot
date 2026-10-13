import Carbon
// Prints, or switches, the current keyboard input source. Used by the smoke
// tests so an input method cannot rewrite simulated keystrokes.
// usage: inputsource get | inputsource set <id>
let args = CommandLine.arguments
func current() -> String {
  let src = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  return Unmanaged<CFString>.fromOpaque(TISGetInputSourceProperty(src, kTISPropertyInputSourceID)).takeUnretainedValue() as String
}
if args.count > 2 && args[1] == "set" {
  let filter = [kTISPropertyInputSourceID as String: args[2]] as CFDictionary
  guard let list = TISCreateInputSourceList(filter, false)?.takeRetainedValue() as? [TISInputSource], let src = list.first else { print("not found"); exit(1) }
  TISSelectInputSource(src)
}
print(current())
