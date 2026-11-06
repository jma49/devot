import {
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'
import { inEditor, useMenuEvent } from '../commands/dispatch'
import type { EditorHandle } from '../editor/handle'
import { currentDefaultMode, type LastState } from '../lastState'
import { editorOnly, type Mode } from '../ModeControl'
import { measureModePanes, type ModeBoxes, playModeChange } from '../paneMotion'
import { MENU_ECHO_MS } from './usePanes'

const TOGGLE_PREVIEW = 'devot:toggle-preview'
const SHOW_SPLIT = 'devot:show-split'

/** The open note's mode (an editor mode, Preview or Split) and the editor mode to go back to. */
export function useMode(lastState: LastState | undefined) {
  const [mode, setMode] = useState<Mode>(() => lastState?.mode ?? currentDefaultMode())
  // Leaving Preview or Split goes back to the editor mode used last.
  const editorMode = useRef(editorOnly(mode) ? mode : currentDefaultMode())
  // oxlint-disable-next-line react/refs -- The editor mode to go back to follows each render's mode, before any effect reads it.
  if (editorOnly(mode)) editorMode.current = mode
  return { mode, setMode, editorMode }
}

/** Cmd+E, View > Show Split and the panes moving as the mode changes. */
export function useModeSwitch({
  mode,
  setMode,
  editorMode,
  editorRef,
}: {
  mode: Mode
  setMode: Dispatch<SetStateAction<Mode>>
  editorMode: RefObject<Mode>
  editorRef: RefObject<EditorHandle | null>
}) {
  // Cmd+E: editor and preview swap; from split, the pane that has the
  // keyboard is the one that stays.
  const previewKeyEcho = useRef(-Infinity)
  const modeKeyboard = useRef<'editor' | 'preview' | undefined>(undefined)
  useLayoutEffect(() => {
    const to = modeKeyboard.current
    modeKeyboard.current = undefined
    if (to === 'editor') editorRef.current?.focus()
    else if (to === 'preview') document.querySelector<HTMLElement>('main .preview')?.focus()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The pane asked for takes the keyboard once the mode has changed.
  }, [mode, editorRef])
  const [modeSeen, setModeSeen] = useState(mode)
  const modeChange = useRef<{ from: Mode; before: ModeBoxes } | null>(null)
  if (modeSeen !== mode) {
    // oxlint-disable-next-line react/refs -- The panes are measured before the mode change commits, while their old layout is on screen (paneMotion.ts).
    modeChange.current = { from: modeSeen, before: measureModePanes() }
    setModeSeen(mode)
  }
  useLayoutEffect(() => {
    const change = modeChange.current
    modeChange.current = null
    if (change) playModeChange(change.from, modeSeen, change.before)
  }, [modeSeen])
  const togglePreview = () => {
    const from = document.activeElement
    const next =
      mode === 'split'
        ? from?.closest('.preview')
          ? 'preview'
          : editorMode.current
        : editorOnly(mode)
          ? 'preview'
          : editorMode.current
    if (next !== mode) {
      if (editorOnly(mode) && inEditor(from)) modeKeyboard.current = 'preview'
      else if (mode === 'preview' && from?.closest('.preview')) modeKeyboard.current = 'editor'
    }
    setMode(next)
  }
  useMenuEvent('devot://toggle-preview', TOGGLE_PREVIEW, () => {
    // The key reaches the menu too; the window already ran the command.
    if (performance.now() >= previewKeyEcho.current) togglePreview()
  })
  useMenuEvent('devot://show-split', SHOW_SPLIT, () => setMode('split'))
  const togglePreviewCommand = () => {
    previewKeyEcho.current = performance.now() + MENU_ECHO_MS
    togglePreview()
  }
  return togglePreviewCommand
}
