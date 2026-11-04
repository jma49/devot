import { Facet, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { ImageSize } from '../../../core/images'
import { readClipboardText } from '../clipboard'
import { editorCommandKeys } from '../commands/registry'
import {
  imageActionApplies,
  imageKeys,
  imageMenuTarget,
  runImageAction,
  type ImageSource,
} from '../imageMenu'
import { selectedText } from './extract'
import { imageAt, imageSizeChange, viewImageAt } from './images'
import { linkForNewNote } from './lineCommands'
import { pasteUrlAs, plainPaste } from './paste'
import { showChooser } from './pasteChooser'
import { registryKeys } from './registryKeys'

export async function pastePlain(view: EditorView): Promise<void> {
  const text = await readClipboardText().catch(() => {
    console.warn('W_CLIPBOARD_READ_FAILED')
    return ''
  })
  const spec = plainPaste(view.state, text)
  if (spec) view.dispatch(spec)
}

export async function pasteUrlAsIn(view: EditorView): Promise<void> {
  const text = await readClipboardText().catch(() => {
    console.warn('W_CLIPBOARD_READ_FAILED')
    return ''
  })
  const spec = pasteUrlAs(view.state, text)
  if (!spec) return
  view.dispatch(spec)
  showChooser(view)
}

export const pasteUrlAsKeys = registryKeys(() =>
  keymap.of(
    editorCommandKeys('edit.pasteUrlAs').map((key) => ({
      key,
      run: (view: EditorView) => {
        void pasteUrlAsIn(view)
        return true
      },
      preventDefault: true,
    })),
  ),
)

/** Paste as Plain Text keys, ahead of CodeMirror's own bindings such as format and find. */
export const pastePlainKeys = registryKeys(() =>
  Prec.high(
    keymap.of(
      editorCommandKeys('edit.pastePlain').map((key) => ({
        key,
        run: (view: EditorView) => {
          void pastePlain(view)
          return true
        },
        preventDefault: true,
      })),
    ),
  ),
)

/** What New Note from Selection does here (the window makes the note); false when it cannot. */
export const newFromSelection = Facet.define<() => boolean, (() => boolean) | undefined>({
  combine: (all) => all[0],
})

/** With text selected the keys hand it to the window; with none they do nothing. */
export const newFromSelectionKeys = registryKeys(() =>
  Prec.high(
    keymap.of(
      editorCommandKeys('note.newFromSelection').map((key) => ({
        key,
        run: (view: EditorView) =>
          selectedText(view.state) !== null && (view.state.facet(newFromSelection)?.() ?? false),
        preventDefault: true,
      })),
    ),
  ),
)

export const newFromLink = Facet.define<() => boolean, (() => boolean) | undefined>({
  combine: (all) => all[0],
})

export const newFromLinkKeys = registryKeys(() =>
  Prec.high(
    keymap.of(
      editorCommandKeys('note.newFromLink').map((key) => ({
        key,
        run: (view: EditorView) =>
          linkForNewNote(view.state, view.state.selection.main.head) !== undefined &&
          (view.state.facet(newFromLink)?.() ?? false),
        preventDefault: true,
      })),
    ),
  ),
)

export function setImageSize(view: EditorView, source: ImageSource, size: ImageSize): boolean {
  const change = imageSizeChange(view.state, source, size)
  if (!change) {
    console.warn('W_IMAGE_SIZE_STALE')
    return false
  }
  view.dispatch(change)
  return true
}

/** Image command keys (none by default): they do nothing when there is no image or the command does not apply. */
export const imageCommandKeys = registryKeys(() =>
  Prec.high(
    keymap.of([
      ...imageKeys().map(({ action, key }) => ({
        key,
        run: (view: EditorView) => {
          const image = imageAt(view.state, view.state.selection.main.head)
          const target = image && imageMenuTarget(image)
          if (!target || !imageActionApplies(action, target)) return false
          void runImageAction(action, target, (source, size) => setImageSize(view, source, size))
          return true
        },
        preventDefault: true,
      })),
      ...editorCommandKeys('image.view').map((key) => ({
        key,
        run: viewImageAt,
        preventDefault: true,
      })),
    ]),
  ),
)
