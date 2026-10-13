// Parts of the note editor built from the command registry's keys (the
// format, table, find and paste keymaps, and CodeMirror's own bindings less
// the window's keys). Each sits in a compartment, so when the keys in effect
// change (Settings > Keyboard Shortcuts) the open editor rebinds them in one
// transaction, keeping its text, selection, undo history and focus.
import { Compartment, type Extension, type StateEffect } from '@codemirror/state'

const parts: { compartment: Compartment; build: () => Extension }[] = []

/**
 * Declares a part built from the registry's keys; call once, at module
 * level. Returns what adds the part to an editor, built from the keys in
 * effect then.
 */
export function registryKeys(build: () => Extension): () => Extension {
  const compartment = new Compartment()
  parts.push({ compartment, build })
  return () => compartment.of(build())
}

/** The effects that rebuild every part from the keys in effect now. */
export function reconfigureRegistryKeys(): StateEffect<unknown>[] {
  return parts.map(({ compartment, build }) => compartment.reconfigure(build()))
}
