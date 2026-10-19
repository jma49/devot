// Find in the open note: the bar's state, the shortcuts, and which pane the
// bar searches. In edit mode that is the editor and in preview mode the
// preview; in split mode it is the pane that has the keyboard focus when
// find opens (the editor unless the preview has it). The keys are the
// registry's `find.*` commands; the palette runs the same actions.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { findMatches, type FindOptions } from '../../../core/find'
import { escapeRegExp } from '../../../core/search'
import type { CommandHandlers } from '../commands/registry'
import { isImeKey } from '../ime'
import type { Mode } from '../ModeControl'
import { FindBar } from './FindBar'
import { FIND_COMMANDS, findShortcut, type FindAction } from './keys'
import { NO_MATCHES, type FindStatus, type FindStep, type FindTarget } from './target'

type Pane = 'editor' | 'preview'

interface Input {
  mode: Mode
  noteOpen: boolean
  editor: FindTarget | null
  preview: FindTarget | null
}

const TOGGLES: ReadonlySet<FindAction> = new Set(['regexp', 'caseSensitive'])

export function useFind({ mode, noteOpen, editor, preview }: Input): {
  bar: ReactNode
  commands: CommandHandlers
} {
  const [open, setOpen] = useState(false)
  const [withReplace, setWithReplace] = useState(false)
  const [chosen, setChosen] = useState<Pane>('editor')
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [regexp, setRegexp] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  // Bumped when the searched pane's matches change, to render them again.
  const [, setChanges] = useState(0)
  const [focusRequest, setFocusRequest] = useState(0)
  const field = useRef<HTMLInputElement>(null)
  const pendingStep = useRef<FindStep | undefined>(undefined)
  const bar = useRef<HTMLDivElement>(null)

  if (open && !noteOpen) setOpen(false)

  const pane: Pane = mode === 'edit' ? 'editor' : mode === 'preview' ? 'preview' : chosen
  const target = pane === 'editor' ? editor : preview
  const status: FindStatus = open && noteOpen && target ? target.status() : NO_MATCHES
  const options = useMemo<FindOptions>(
    () => ({ query, regexp, caseSensitive }),
    [query, regexp, caseSensitive],
  )

  const close = useCallback(() => {
    setOpen(false)
    target?.focus()
  }, [target])

  const closeRef = useRef(close)
  useEffect(() => {
    closeRef.current = close
  })
  // While the bar is open: listen to the pane, and take its marks away when
  // the bar closes or moves to the other pane.
  useLayoutEffect(() => {
    if (!open || !target) return
    const stop = target.subscribe((change) => {
      if (change === 'close') closeRef.current()
      else if (change === 'next') target.next()
      else if (change === 'previous') target.previous()
      else setChanges((n) => n + 1)
    })
    return () => {
      stop()
      target.clear()
    }
  }, [open, target])
  // Searches as the query changes (before paint, so the count never shows
  // the previous query).
  useLayoutEffect(() => {
    if (!open || !target) return
    target.search(options, pendingStep.current)
    pendingStep.current = undefined
  }, [open, target, options])

  useEffect(() => {
    if (focusRequest === 0) return
    field.current?.focus()
    field.current?.select()
  }, [focusRequest])

  /**
   * Opens the bar on the focused pane: seeded with its selection, or, with
   * `step`, with the last query and on to the next (or previous) match.
   */
  const show = (replace: boolean, step?: FindStep) => {
    const focused = document.activeElement
    const inBar = bar.current?.contains(focused) ?? false
    const next: Pane =
      mode === 'edit'
        ? 'editor'
        : mode === 'preview'
          ? 'preview'
          : inBar
            ? chosen
            : preview?.owns(focused)
              ? 'preview'
              : 'editor'
    const nextTarget = next === 'editor' ? editor : preview
    if (!nextTarget) return
    // A selection the user made becomes the query; a match find selected
    // (the bar's current match, or the one left selected when it closed)
    // does not.
    const selected =
      step || inBar || (open && next === pane && status.current !== null)
        ? ''
        : nextTarget.selectedText()
    if (selected && !matchesWhole(selected, options))
      setQuery(regexp ? escapeRegExp(selected) : selected)
    pendingStep.current = step
    setChosen(next)
    setWithReplace(replace)
    setOpen(true)
    setFocusRequest((n) => n + 1)
  }

  const run = (action: FindAction) => {
    if (action === 'find' || action === 'replace') show(action === 'replace')
    else if (action === 'regexp') setRegexp((on) => !on)
    else if (action === 'caseSensitive') setCaseSensitive((on) => !on)
    else if (!open) show(withReplace, action)
    else if (action === 'next') target?.next()
    else target?.previous()
  }

  // Window-wide, ahead of the editor (whose own Cmd+F and Cmd+G would open
  // CodeMirror's search). The toggles only act while the bar is open. Keys an
  // input method composes with are its own.
  const latest = useRef({ run, open, noteOpen, target })
  useEffect(() => {
    latest.current = { run, open, noteOpen, target }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e)) return
      const action = findShortcut(e)
      if (!action || document.querySelector('dialog[open]')) return
      const now = latest.current
      if (!now.noteOpen) return
      if (TOGGLES.has(action) && !now.open) return
      e.preventDefault()
      e.stopPropagation()
      now.run(action)
    }
    // Escape in the bar or the searched pane closes the bar, unless something
    // there used it first (the editor's popups do, and an input method
    // cancels its composition with it).
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isImeKey(e) || e.defaultPrevented || !latest.current.open) return
      const node = e.target instanceof Node ? e.target : null
      if (!bar.current?.contains(node) && !latest.current.target?.owns(node)) return
      e.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keydown', onEscape)
    }
  }, [])

  const commands: CommandHandlers = {}
  if (noteOpen) {
    for (const action of Object.keys(FIND_COMMANDS) as FindAction[]) {
      if (TOGGLES.has(action) && !open) continue
      commands[FIND_COMMANDS[action]] = { run: () => run(action) }
    }
  }

  if (!open || !noteOpen) return { bar: null, commands }
  return {
    commands,
    bar: (
      <FindBar
        fieldRef={field}
        barRef={bar}
        query={query}
        replacement={replacement}
        regexp={regexp}
        caseSensitive={caseSensitive}
        replace={withReplace && (target?.canReplace ?? false)}
        status={status}
        onQuery={setQuery}
        onReplacement={setReplacement}
        onToggleRegexp={() => setRegexp((on) => !on)}
        onToggleCase={() => setCaseSensitive((on) => !on)}
        onNext={() => target?.next()}
        onPrevious={() => target?.previous()}
        onReplace={() => target?.replace(replacement)}
        onReplaceAll={() => target?.replaceAll(replacement)}
        onClose={close}
      />
    ),
  }
}

function matchesWhole(text: string, options: FindOptions): boolean {
  return findMatches(text, options).matches.some((m) => m.from === 0 && m.to === text.length)
}
