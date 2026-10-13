import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { shortcutLabel } from '../commands/keys'
import { t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import { isImeKey } from '../ime'
import type { IconName } from '../icons/symbols'
import { paletteGroups, type PaletteEntry, type PaletteKind } from './results'

/**
 * What picking a result does; `label` names it in the key hints. `run` may
 * return a promise that settles once the action is done (a note opened).
 */
export interface PaletteAction {
  label: string
  run: () => void | Promise<unknown>
}

/** A result's actions: Return runs `primary`, Option+Return (or Option-click) `secondary`. */
export interface PaletteActions {
  primary: PaletteAction
  secondary?: PaletteAction | undefined
}

const GROUP_LABEL: Readonly<Record<PaletteKind, MessageKey>> = {
  command: 'palette.commands',
  book: 'palette.notebooks',
  tag: 'palette.tags',
  note: 'palette.notes',
}

const ICON: Readonly<Record<PaletteKind, IconName | undefined>> = {
  command: undefined,
  book: 'notebook',
  tag: 'tag',
  note: 'notes.all',
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
 * The command palette: one field that finds commands, notebooks, tags and
 * notes. Arrow keys move through the results, Return runs the selected one,
 * Option+Return its second action (move the open note to a notebook, add a
 * tag to it), Escape closes. `onClose` gives the keyboard back, then runs
 * the picked action (`picked`), if any, and sees to the keyboard once it is done.
 */
export function CommandPalette(props: {
  entries: Readonly<Record<PaletteKind, readonly PaletteEntry[]>>
  actions: (entry: PaletteEntry) => PaletteActions
  onClose: (picked?: () => void | Promise<unknown>) => void
}) {
  const { entries, actions, onClose } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  const groups = useMemo(() => paletteGroups(query, entries), [query, entries])
  const results = groups.flatMap((g) => g.results)
  // Where each group starts in `results` (options are numbered across groups).
  const starts = groups.map((_, i) =>
    groups.slice(0, i).reduce((sum, g) => sum + g.results.length, 0),
  )
  const list = useRef<HTMLDivElement>(null)
  const index = Math.min(active, results.length - 1)
  const current = results[index]
  const hints = current ? actions(current) : undefined

  useEffect(() => {
    document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const close = (picked?: () => void | Promise<unknown>) => {
    // Closed first, so the keyboard can go back to the window.
    dialog.current?.close()
    onClose(picked)
  }

  /** Runs a result's second action, or its first when it has no second. */
  const pick = (entry: PaletteEntry, secondary: boolean) => {
    const choice = actions(entry)
    const action = (secondary ? choice.secondary : undefined) ?? choice.primary
    close(() => action.run())
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Keys that pick or confirm an input method's candidate are not ours.
    if (isImeKey(e.nativeEvent)) return
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (step) {
      e.preventDefault()
      setActive(Math.max(0, Math.min(results.length - 1, index + step)))
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault()
      if (current) pick(current, e.altKey)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label={t('command.palette')}
      onCancel={(e) => {
        e.preventDefault()
        close()
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
      <input
        className="palette-input"
        type="text"
        role="combobox"
        aria-label={t('command.palette')}
        placeholder={t('palette.placeholder')}
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
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
          // New results start at the top.
          if (list.current) list.current.scrollTop = 0
        }}
        onKeyDown={onKeyDown}
      />
      <div
        ref={list}
        id="palette-results"
        className="palette-results"
        role="listbox"
        aria-label={t('palette.results')}
      >
        {groups.map((group, g) => (
          <div key={group.kind} role="group" aria-label={t(GROUP_LABEL[group.kind])}>
            <div className="palette-group" aria-hidden="true">
              {t(GROUP_LABEL[group.kind])}
            </div>
            {group.results.map((r, j) => {
              const i = (starts[g] ?? 0) + j
              const icon = ICON[r.kind]
              return (
                <div
                  key={`${r.kind}:${r.id}`}
                  id={optionId(i)}
                  className="palette-row"
                  role="option"
                  aria-selected={i === index}
                  onMouseMove={() => i !== index && setActive(i)}
                  onClick={(e) => pick(r, e.altKey)}
                >
                  {icon ? <Icon name={icon} size="sm" /> : <span className="palette-icon" />}
                  <span className="palette-label">
                    <Marked text={r.label} ranges={r.ranges} />
                    {r.detail ? <span className="palette-detail">{r.detail}</span> : null}
                  </span>
                  {r.shortcut ? <kbd className="palette-key">{r.shortcut}</kbd> : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {results.length === 0 ? <p className="palette-empty">{t('palette.empty')}</p> : null}
      <div id="palette-keys" className="palette-keys">
        {hints ? (
          <>
            <span>
              <kbd>{shortcutLabel('Enter')}</kbd> {hints.primary.label}
            </span>
            {hints.secondary ? (
              <span>
                <kbd>{shortcutLabel('Alt+Enter')}</kbd> {hints.secondary.label}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
    </dialog>
  )
}
