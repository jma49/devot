import { fieldStep } from '../Picker'
import {
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { shortcutLabel } from '../commands/keys'
import { format, t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import { BookIcon } from '../BookIcon'
import { TagDot } from '../TagDot'
import { isImeKey } from '../ime'
import { searchPattern } from '../../../core/search'
import type { IconName } from '../icons/symbols'
import { Marked, MarkedRanges } from '../Marked'
import { createBodySearchController, type PaletteBodySearch } from './bodySearch'
import {
  escapeStep,
  lineOfQuery,
  mergeBodyMatches,
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
  content: 'palette.matchingContent',
  outline: 'palette.outline',
  line: 'palette.line',
  source: 'palette.sources',
}

const ICON: Readonly<Record<PaletteKind, IconName>> = {
  command: 'terminal',
  book: 'notebook',
  tag: 'tag',
  note: 'notes.all',
  content: 'notes.all',
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
  searchNotes?: PaletteBodySearch | undefined
  initialScope?: PaletteSource | undefined
  /** How many lines the open note has (Go to Line); 0 or none when no note is open. */
  lineCount?: number | undefined
  onClose: (picked?: () => void | Promise<unknown>) => void
}) {
  const { entries, actions, searchNotes, onClose } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<PaletteState>(() =>
    props.initialScope ? { scope: props.initialScope, query: '' } : ROOT,
  )
  const [bodyMatches, setBodyMatches] = useState<readonly PaletteEntry[]>([])
  const bodyController = useRef<ReturnType<typeof createBodySearchController>>(null)
  const stateRef = useRef(state)
  const searchNotesRef = useRef(searchNotes)
  useInsertionEffect(() => {
    stateRef.current = state
    searchNotesRef.current = searchNotes
  })
  const hasSearch = Boolean(searchNotes)
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

  useEffect(() => {
    if (!hasSearch) {
      bodyController.current = null
      return
    }
    const controller = createBodySearchController({
      search: (q) => (searchNotesRef.current ? searchNotesRef.current(q) : Promise.resolve([])),
      onResults: setBodyMatches,
    })
    bodyController.current = controller
    controller.update(stateRef.current)
    return () => {
      controller.reset()
      if (bodyController.current === controller) bodyController.current = null
    }
  }, [hasSearch])

  const lineCount = props.lineCount ?? 0
  const syncGroups = useMemo(() => {
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
  const groups = useMemo(() => {
    if (!hasSearch) return syncGroups
    return mergeBodyMatches(syncGroups, bodyMatches)
  }, [hasSearch, syncGroups, bodyMatches])
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
    bodyController.current?.reset()
    // Closed first, so the keyboard can go back to the window.
    dialog.current?.close()
    onClose(picked)
  }

  const change = (next: PaletteState) => {
    setState(next)
    bodyController.current?.update(next)
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
    } else if (e.key === 'Tab' && !isModified(e) && current?.kind === 'source') {
      e.preventDefault()
      pick(current, NO_MODIFIERS)
    } else if (e.key === 'Backspace' && state.scope !== null && state.query === '') {
      e.preventDefault()
      change(ROOT)
    }
  }

  const actionHints: { keys: string; label: string; active?: boolean }[] = (() => {
    if (!current) return []
    if (current.kind === 'source') return [{ keys: 'Enter', label: t('palette.open') }]
    if (!hints) return []
    const items: { keys: string; label: string; active?: boolean }[] = [
      { keys: 'Enter', label: hints.primary.label },
    ]
    if (hints.shift) {
      items.push({
        keys: 'Shift+Enter',
        label: hints.shift.label,
        active: held.shift && !held.meta,
      })
    }
    if (hints.meta) {
      items.push({
        keys: 'Mod+Enter',
        label: hints.meta.label,
        active: held.meta,
      })
    }
    return items
  })()

  const scope = state.scope
  const placeholder = scope === null ? t('palette.placeholder') : t(PLACEHOLDER[scope])
  const showHeaders = scope === null
  const showTabHint = current?.kind === 'source'

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
            const next = typeInto(state, e.target.value)
            setState(next)
            bodyController.current?.update(next)
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
            {showHeaders || group.kind === 'content' ? (
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
                  className={
                    r.kind === 'content' ? 'palette-row palette-row-content' : 'palette-row'
                  }
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
                  ) : r.tagColor ? (
                    <span className="tag-dot-box">
                      <TagDot color={r.tagColor} name={r.label} />
                    </span>
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
                  {r.kind === 'content' ? (
                    <>
                      <span className="palette-label palette-content-line" dir="auto">
                        <span className="palette-content-title">{r.label}</span>
                        {r.excerpt ? (
                          <span className="palette-excerpt">
                            <Marked
                              text={r.excerpt}
                              pattern={searchPattern(r.highlightTerms ?? [])}
                            />
                          </span>
                        ) : null}
                      </span>
                      {r.detail ? <span className="palette-badge">{r.detail}</span> : null}
                    </>
                  ) : (
                    <span
                      className={`palette-label${r.kind === 'command' ? ' palette-command' : ''}${r.done ? ' palette-done' : ''}`}
                      dir="auto"
                    >
                      <MarkedRanges text={r.label} ranges={r.ranges} />
                      {r.description ? (
                        <span className="palette-description">{r.description}</span>
                      ) : null}
                      {r.detail ? <span className="palette-detail">{r.detail}</span> : null}
                    </span>
                  )}
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
        {actionHints.map((hint) => (
          <span
            key={hint.keys}
            className="palette-hint"
            data-active={hint.active ? 'true' : undefined}
          >
            <kbd>{shortcutLabel(hint.keys)}</kbd> {hint.label}
          </span>
        ))}
        {showTabHint ? (
          <span className="palette-hint">
            <kbd>{shortcutLabel('Tab')}</kbd> {t('palette.openSource')}
          </span>
        ) : null}
        <span className="palette-hint">
          <kbd>{t('palette.key.escape')}</kbd>{' '}
          {escapeStep(state) === null ? t('palette.close') : t('palette.back')}
        </span>
      </div>
    </dialog>
  )
}
