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
import { useEditorSetting } from '../editorSettings'
import { format, t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import { BookIcon } from '../BookIcon'
import { isImeKey } from '../ime'
import type { IconName } from '../icons/symbols'
import {
  escapeStep,
  lineOfQuery,
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

interface Held {
  shift: boolean
  meta: boolean
}

const NO_MODIFIERS: Held = { shift: false, meta: false }

const isModified = (e: KeyboardEvent) => e.shiftKey || e.metaKey || e.ctrlKey || e.altKey

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
  line: 'palette.line',
  source: 'palette.sources',
}

const ICON: Readonly<Record<PaletteKind, IconName>> = {
  command: 'terminal',
  book: 'notebook',
  tag: 'tag',
  note: 'notes.all',
  outline: 'outline',
  line: 'find.next',
  source: 'search',
}

const SOURCE_ICON: Readonly<Record<PaletteSource, IconName>> = {
  command: 'terminal',
  book: 'notebook',
  tag: 'tag',
  outline: 'outline',
  line: 'find.next',
  note: 'notes.all',
}

const PLACEHOLDER: Readonly<Record<PaletteSource, MessageKey>> = {
  command: 'palette.placeholder.command',
  book: 'palette.placeholder.book',
  tag: 'palette.placeholder.tag',
  outline: 'palette.placeholder.outline',
  line: 'palette.placeholder.line',
  note: 'palette.placeholder.note',
}

const optionId = (i: number) => `palette-option-${i}`

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
  initialScope?: PaletteSource | undefined
  /** How many lines the open note has (Go to Line); 0 or none when no note is open. */
  lineCount?: number | undefined
  onClose: (picked?: () => void | Promise<unknown>) => void
}) {
  const { entries, actions, onClose } = props
  const glass = useEditorSetting('sidebarMaterial')
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
    // showModal focuses the dialog's first control, which is the Back button
    // when the palette opens scoped (Go to Line, the sidebar's search
    // buttons): the field keeps the keyboard.
    input.current?.focus()
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

  const lineCount = props.lineCount ?? 0
  const groups = useMemo(() => {
    if (state.scope !== 'line') return paletteResults(state, entries)
    const line = lineOfQuery(state.query, lineCount)
    const goTo: PaletteEntry[] =
      line === null
        ? []
        : [
            {
              kind: 'line',
              id: `line:${line}`,
              label: format(t('palette.goToLineN'), { line: String(line) }),
              line,
            },
          ]
    return paletteResults(state, { ...entries, line: goTo })
  }, [state, entries, lineCount])
  const results = groups.flatMap((g) => g.results)
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
    if (list.current) list.current.scrollTop = 0
    input.current?.focus()
  }

  const pick = (entry: PaletteEntry, modifiers: Held) => {
    if (entry.kind === 'source') {
      if (!modifiers.shift && !modifiers.meta)
        change({ scope: entry.id as PaletteSource, query: '' })
      return
    }
    const action = chosen(actions(entry), modifiers)
    if (action) close(() => action.run())
  }

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
    } else if (e.key === 'Tab' && glass && !isModified(e) && current?.kind === 'source') {
      e.preventDefault()
      pick(current, NO_MODIFIERS)
    } else if (e.key === 'Backspace' && state.scope !== null && state.query === '') {
      e.preventDefault()
      change(ROOT)
    }
  }

  const footer = (() => {
    if (!current) return null
    if (current.kind === 'source') {
      if (held.shift || held.meta) return null
      return { keys: 'Enter', label: glass ? t('palette.open') : t('palette.openSource') }
    }
    if (!hints) return null
    const action = chosen(hints, held)
    if (!action) return null
    const keys = held.meta ? 'Mod+Enter' : held.shift ? 'Shift+Enter' : 'Enter'
    return { keys, label: action.label }
  })()

  const scope = state.scope
  const placeholder = scope === null ? t('palette.placeholder') : t(PLACEHOLDER[scope])
  const showHeaders = scope === null && (glass || state.query.trim() !== '')
  const showTabHint = glass && current?.kind === 'source' && !held.shift && !held.meta

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
                  {r.bookIcon ? (
                    <BookIcon icon={r.bookIcon.icon} color={r.bookIcon.color} size="sm" />
                  ) : (
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
                  )}
                  <span
                    className={`palette-label${r.kind === 'command' ? ' palette-command' : ''}${r.done ? ' palette-done' : ''}`}
                    dir="auto"
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
            : scope === 'line'
              ? lineCount > 0
                ? format(t('palette.noLine'), { lines: String(lineCount) })
                : t('palette.noLineNote')
              : t('palette.empty')}
        </p>
      ) : null}
      <div id="palette-keys" className="palette-keys">
        {footer ? (
          <span className="palette-hint">
            <kbd>{shortcutLabel(footer.keys)}</kbd> {footer.label}
          </span>
        ) : null}
        {showTabHint ? (
          <span className="palette-hint">
            <kbd>{shortcutLabel('Tab')}</kbd> {t('palette.openSource')}
          </span>
        ) : null}
        {glass ? (
          <span className="palette-hint">
            <kbd>{t('palette.key.escape')}</kbd>{' '}
            {escapeStep(state) === null ? t('palette.close') : t('palette.back')}
          </span>
        ) : null}
      </div>
    </dialog>
  )
}
