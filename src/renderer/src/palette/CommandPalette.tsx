import { fieldStep } from '../Picker'
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { shortcutLabel } from '../commands/keys'
import { t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import { isImeKey } from '../ime'
import type { IconName } from '../icons/symbols'
import {
  escapeStep,
  paletteResults,
  ROOT,
  typeInto,
  type PaletteEntry,
  type PaletteKind,
  type PaletteSource,
  type PaletteState,
} from './results'

/**
 * What picking a result does; `label` names it in the key hints. `run` may
 * return a promise that settles once the action is done (a note opened).
 */
export interface PaletteAction {
  label: string
  run: () => void | Promise<unknown>
}

/**
 * A result's actions: Return runs `primary`, Shift+Return `shift` and
 * Command+Return `meta` (the same with a click). A modifier with no action
 * of its own does nothing.
 */
export interface PaletteActions {
  primary: PaletteAction
  shift?: PaletteAction | undefined
  meta?: PaletteAction | undefined
}

/** The modifiers held now, which choose among a result's actions. */
interface Held {
  shift: boolean
  meta: boolean
}

const NO_MODIFIERS: Held = { shift: false, meta: false }

/** The action the modifiers choose; undefined when the result has none for them. */
function chosen(actions: PaletteActions, held: Held): PaletteAction | undefined {
  if (held.meta) return actions.meta
  if (held.shift) return actions.shift
  return actions.primary
}

const GROUP_LABEL: Readonly<Record<PaletteKind, MessageKey>> = {
  command: 'palette.commands',
  book: 'palette.notebooks',
  tag: 'palette.tags',
  note: 'palette.notes',
  outline: 'palette.outline',
  source: 'palette.sources',
}

const ICON: Readonly<Record<PaletteKind, IconName>> = {
  command: 'terminal',
  book: 'notebook',
  tag: 'tag',
  note: 'notes.all',
  outline: 'outline',
  source: 'search',
}

/** The icon of each source's row in the root's list. */
const SOURCE_ICON: Readonly<Record<PaletteSource, IconName>> = {
  command: 'terminal',
  book: 'notebook',
  tag: 'tag',
  outline: 'outline',
  note: 'notes.all',
}

const PLACEHOLDER: Readonly<Record<PaletteSource, MessageKey>> = {
  command: 'palette.placeholder.command',
  book: 'palette.placeholder.book',
  tag: 'palette.placeholder.tag',
  outline: 'palette.placeholder.outline',
  note: 'palette.placeholder.note',
}

const optionId = (i: number) => `palette-option-${i}`

/** `text` with the ranges in `<mark>`; text nodes only. */
function Marked({ text, ranges }: { text: string; ranges: readonly [number, number][] }) {
  const parts: { text: string; match: boolean }[] = []
  let at = 0
  for (const [from, to] of ranges) {
    if (from > at) parts.push({ text: text.slice(at, from), match: false })
    parts.push({ text: text.slice(from, to), match: true })
    at = to
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false })
  return parts.map((p, i) =>
    p.match ? <mark key={i}>{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>,
  )
}

/**
 * The command palette: one field over a list of sources, or over the results
 * of one source it is scoped to (a source's key and a space, or its row).
 * Arrow keys move through the results; Return runs the selected one, with
 * Shift or Command held its variant (the footer says what each does);
 * Escape steps back from a query to the scope, from the scope to the
 * sources, and then closes. `onClose` gives the keyboard back, then runs
 * the picked action (`picked`), if any, and sees to the keyboard once it is done.
 */
export function CommandPalette(props: {
  entries: Readonly<Record<PaletteKind, readonly PaletteEntry[]>>
  actions: (entry: PaletteEntry) => PaletteActions
  /** The source to open scoped to (the sidebar's search buttons). */
  initialScope?: PaletteSource | undefined
  onClose: (picked?: () => void | Promise<unknown>) => void
}) {
  const { entries, actions, onClose } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<PaletteState>(() =>
    props.initialScope ? { scope: props.initialScope, query: '' } : ROOT,
  )
  const [active, setActive] = useState(0)
  const [held, setHeld] = useState<Held>(NO_MODIFIERS)
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  // The modifiers held, for the footer; a window that loses the keyboard
  // forgets them.
  useEffect(() => {
    const track = (e: globalThis.KeyboardEvent) =>
      setHeld((now) =>
        now.shift === e.shiftKey && now.meta === e.metaKey
          ? now
          : { shift: e.shiftKey, meta: e.metaKey },
      )
    const reset = () => setHeld(NO_MODIFIERS)
    window.addEventListener('keydown', track)
    window.addEventListener('keyup', track)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', track)
      window.removeEventListener('keyup', track)
      window.removeEventListener('blur', reset)
    }
  }, [])

  const groups = useMemo(() => paletteResults(state, entries), [state, entries])
  const results = groups.flatMap((g) => g.results)
  // Where each group starts in `results` (options are numbered across groups).
  const starts = groups.map((_, i) =>
    groups.slice(0, i).reduce((sum, g) => sum + g.results.length, 0),
  )
  const list = useRef<HTMLDivElement>(null)
  const index = Math.min(active, results.length - 1)
  const current = results[index]
  const hints = current && current.kind !== 'source' ? actions(current) : undefined

  useEffect(() => {
    document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const close = (picked?: () => void | Promise<unknown>) => {
    // Closed first, so the keyboard can go back to the window.
    dialog.current?.close()
    onClose(picked)
  }

  const change = (next: PaletteState) => {
    setState(next)
    setActive(0)
    // New results start at the top.
    if (list.current) list.current.scrollTop = 0
    input.current?.focus()
  }

  /** Runs what the held modifiers choose for a result (a source row opens the source). */
  const pick = (entry: PaletteEntry, modifiers: Held) => {
    if (entry.kind === 'source') {
      if (!modifiers.shift && !modifiers.meta)
        change({ scope: entry.id as PaletteSource, query: '' })
      return
    }
    const action = chosen(actions(entry), modifiers)
    if (action) close(() => action.run())
  }

  /** Escape, from the field or the dialog: one step back, then closed. */
  const stepBack = () => {
    const next = escapeStep(state)
    if (next === null) close()
    else change(next)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Keys that pick or confirm an input method's candidate are not ours.
    if (isImeKey(e.nativeEvent)) return
    const next = fieldStep(e.key, index, results.length)
    if (next !== undefined) {
      e.preventDefault()
      if (next >= 0) setActive(next)
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      if (current) pick(current, { shift: e.shiftKey, meta: e.metaKey })
    } else if (e.key === 'Backspace' && state.scope !== null && state.query === '') {
      // Nothing left to delete: the scope goes.
      e.preventDefault()
      change(ROOT)
    }
  }

  const footer = (() => {
    if (!current) return null
    if (current.kind === 'source') {
      return held.shift || held.meta ? null : { keys: 'Enter', label: t('palette.openSource') }
    }
    if (!hints) return null
    const action = chosen(hints, held)
    if (!action) return null
    const keys = held.meta ? 'Mod+Enter' : held.shift ? 'Shift+Enter' : 'Enter'
    return { keys, label: action.label }
  })()

  const scope = state.scope
  const placeholder = scope === null ? t('palette.placeholder') : t(PLACEHOLDER[scope])
  const showHeaders = scope === null && state.query.trim() !== ''

  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label={t('command.palette')}
      onCancel={(e) => {
        e.preventDefault()
        stepBack()
      }}
      // A click on the backdrop lands on the dialog itself, as do clicks on
      // its padding: only one outside its box closes it.
      onClick={(e: MouseEvent) => {
        const box = dialog.current?.getBoundingClientRect()
        if (e.target !== dialog.current || !box) return
        const inside =
          e.clientX >= box.left &&
          e.clientX <= box.right &&
          e.clientY >= box.top &&
          e.clientY <= box.bottom
        if (!inside) close()
      }}
    >
      <div className="palette-field">
        {scope === null ? (
          <span className="palette-lead">
            <Icon name="search" size="md" />
          </span>
        ) : (
          <button
            type="button"
            className="palette-lead palette-back"
            aria-label={t('palette.back')}
            title={t('palette.back')}
            // The field keeps the keyboard.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => change(ROOT)}
          >
            <Icon name="nav.back" size="md" />
          </button>
        )}
        <input
          ref={input}
          className="palette-input"
          type="text"
          role="combobox"
          aria-label={t('command.palette')}
          placeholder={placeholder}
          aria-expanded="true"
          aria-controls="palette-results"
          aria-autocomplete="list"
          aria-activedescendant={current ? optionId(index) : undefined}
          aria-describedby="palette-keys"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          value={state.query}
          onChange={(e) => {
            setState(typeInto(state, e.target.value))
            setActive(0)
            // New results start at the top.
            if (list.current) list.current.scrollTop = 0
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div
        ref={list}
        id="palette-results"
        className="palette-results"
        role="listbox"
        aria-label={t('palette.results')}
      >
        {groups.map((group, g) => (
          <div key={group.kind} role="group" aria-label={t(GROUP_LABEL[group.kind])}>
            {showHeaders ? (
              <div className="palette-group" aria-hidden="true">
                {t(GROUP_LABEL[group.kind])}
              </div>
            ) : null}
            {group.results.map((r, j) => {
              const i = (starts[g] ?? 0) + j
              return (
                <div
                  key={`${r.kind}:${r.id}`}
                  id={optionId(i)}
                  className="palette-row"
                  role="option"
                  aria-selected={i === index}
                  style={
                    r.kind === 'outline' && r.depth
                      ? ({ '--palette-depth': r.depth } as CSSProperties)
                      : undefined
                  }
                  onMouseMove={() => i !== index && setActive(i)}
                  onClick={(e) => pick(r, { shift: e.shiftKey, meta: e.metaKey })}
                >
                  <Icon
                    name={
                      r.kind === 'source'
                        ? SOURCE_ICON[r.id as PaletteSource]
                        : r.kind === 'outline'
                          ? r.level === 0
                            ? 'format.taskList'
                            : 'format.heading'
                          : ICON[r.kind]
                    }
                    size="sm"
                  />
                  <span
                    className={`palette-label${r.kind === 'command' ? ' palette-command' : ''}${r.done ? ' palette-done' : ''}`}
                  >
                    <Marked text={r.label} ranges={r.ranges} />
                    {r.description ? (
                      <span className="palette-description">{r.description}</span>
                    ) : null}
                    {r.detail ? <span className="palette-detail">{r.detail}</span> : null}
                  </span>
                  {r.shortcut ? <kbd className="palette-key">{r.shortcut}</kbd> : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {results.length === 0 ? (
        <p className="palette-empty">
          {scope === 'outline' && state.query.trim() === ''
            ? t('palette.noOutline')
            : t('palette.empty')}
        </p>
      ) : null}
      <div id="palette-keys" className="palette-keys">
        {footer ? (
          <span>
            <kbd>{shortcutLabel(footer.keys)}</kbd> {footer.label}
          </span>
        ) : null}
      </div>
    </dialog>
  )
}
