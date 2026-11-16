// Edit buttons on plugin drawings (ADR 0029), apart from the drawings themselves so the preview hears their clicks
// without loading what draws them.

/** Marks a drawing's Edit button. */
export const EDIT_ATTRIBUTE = 'data-plugin-edit'

export interface PluginEditor {
  /** The renderer keys whose blocks the plugin may edit. */
  editable: ReadonlySet<string>
  /** Edits the block at `at` in the note in its plugin and puts the edit back; it reports its own failures. */
  edit(key: string, source: string, at: { from: number; to: number }): Promise<void>
}

let editor: PluginEditor | undefined

export function setPluginEditor(next: PluginEditor | undefined): void {
  editor = next
}

export const editableBlock = (key: string): boolean => editor?.editable.has(key) === true

/** Edits the drawing `island` shows, which is at `at` in the note, in its plugin. */
export function editPluginBlock(island: Element, at: { from: number; to: number }): void {
  const source = island.getAttribute('data-island-source') ?? ''
  const end = source.indexOf('\n')
  const key = end > 0 ? source.slice(0, end) : ''
  if (editor?.editable.has(key)) void editor.edit(key, source.slice(end + 1), at)
}
