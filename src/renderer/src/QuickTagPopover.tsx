import {
  useEffect,
  useId,
  useInsertionEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import type { TagColorValue, TagRecord } from '../../core/storage'
import { isCustomTagColor, MAX_TAG_NAME_CHARS } from '../../core/tags'
import { closingRef } from './closing'
import { ColorPicker } from './ColorPicker'
import { ColorSwatches } from './ColorSwatches'
import { currentLocale, format, t } from './i18n'
import { isImeKey } from './ime'
import { useNameLimit } from './nameLimit'
import { fieldStep, placePickerPanel } from './Picker'
import { quickTagRows, readRecentTags, rememberTag } from './quickTag'
import { localStore } from './localStore'
import { dotCase, TagDot } from './TagDot'
import { tagDotClass } from './tagColorStyle'
import type { TagRow } from './tagRows'

const panelRef = closingRef('scale', 'quick-tag')

/** What is typed for the next tag; `making` holds the text whose new tag is being made. */
type Draft = { text: string; active: number; color: TagColorValue | null; making: string | null }
type DraftEvent =
  | { kind: 'type'; text: string }
  | { kind: 'step'; active: number }
  | { kind: 'color'; color: TagColorValue | null }
  | { kind: 'applied' }
  | { kind: 'making' }
  | { kind: 'made'; ok: boolean }

const EMPTY: Draft = { text: '', active: -1, color: null, making: null }

/** A new tag clears what was typed only once it is made, so a refused one keeps it to try again. */
function draftStep(draft: Draft, event: DraftEvent): Draft {
  switch (event.kind) {
    case 'type':
      return { ...draft, text: event.text, active: event.text.trim() === '' ? -1 : 0 }
    case 'step':
      return { ...draft, active: event.active }
    case 'color':
      return { ...draft, color: event.color }
    case 'applied':
      return { ...EMPTY, making: draft.making }
    case 'making':
      return { ...draft, making: draft.text }
    case 'made':
      return event.ok && draft.text === draft.making ? EMPTY : { ...draft, making: null }
  }
}

/**
 * Tags a note from one pop-up: a field, the matching tags with their counts, and a row that
 * creates a new one in a colour from the swatches. Return applies and stays open for the next
 * tag; Escape closes and gives the keyboard back.
 */
export function QuickTag(props: {
  tags: readonly TagRecord[]
  onNote: readonly string[]
  counts: ReadonlyMap<string, number>
  onPut: (tagId: string, name: string) => void
  onCreate: (name: string, color: TagColorValue | null) => Promise<string | undefined>
  onClose: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const returnTo = useRef<Element | null>(document.activeElement)
  const onCloseRef = useRef(props.onClose)
  const listId = useId()
  const [{ text: draft, active, color, making }, send] = useReducer(draftStep, EMPTY)
  const setActive = (next: number) => send({ kind: 'step', active: next })
  const setColor = (next: TagColorValue | null) => send({ kind: 'color', color: next })
  const [picking, setPicking] = useState(false)
  const [recent, setRecent] = useState(() => readRecentTags(localStore()))
  const rows = quickTagRows(props.tags, props.onNote, draft, recent)
  const creating = rows.at(-1)?.kind === 'create'
  const changeDraft = (next: string) => send({ kind: 'type', text: next })
  const limit = useNameLimit(draft, MAX_TAG_NAME_CHARS, changeDraft)

  useInsertionEffect(() => {
    onCloseRef.current = props.onClose
  })
  useLayoutEffect(() => {
    if (panel.current) placePickerPanel(panel.current)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Opening or closing the colour picker changes the panel's size, so it is placed again.
  }, [picking])
  useEffect(() => {
    if (!picking) field.current?.focus()
  }, [picking])
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (e.target instanceof Node && panel.current?.contains(e.target)) return
      onCloseRef.current()
    }
    document.addEventListener('mousedown', away, true)
    return () => document.removeEventListener('mousedown', away, true)
  }, [])

  const remember = (id: string) => {
    rememberTag(localStore(), id)
    setRecent(readRecentTags(localStore()))
  }
  const apply = (row: TagRow | undefined) => {
    if (!row) return
    if (row.kind === 'tag') {
      props.onPut(row.tag.id, row.tag.name)
      remember(row.tag.id)
      send({ kind: 'applied' })
    } else if (making === null) {
      send({ kind: 'making' })
      void props.onCreate(row.name, color).then(
        (id) => {
          if (id) remember(id)
          send({ kind: 'made', ok: id !== undefined })
        },
        (error: unknown) => {
          send({ kind: 'made', ok: false })
          throw error
        },
      )
    }
    field.current?.focus()
  }
  const close = () => {
    props.onClose()
    if (returnTo.current instanceof HTMLElement) returnTo.current.focus()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    // A bare key here must not reach the window's commands.
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation()
    if (picking || isImeKey(e.nativeEvent)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      return close()
    }
    if (e.target !== field.current) return
    if (e.key === 'Enter') {
      e.preventDefault()
      return apply(rows[active])
    }
    const next = fieldStep(e.key, active, rows.length)
    if (next !== undefined) {
      e.preventDefault()
      setActive(next)
    }
  }
  const optionId = (i: number) => `${listId}-${i}`

  return (
    <div
      ref={(el) => {
        panel.current = el
        panelRef(el)
      }}
      className="picker-popover quick-tag"
      role="dialog"
      aria-label={t('quickTag.title')}
      onKeyDown={onKeyDown}
    >
      {picking ? (
        <ColorPicker
          value={isCustomTagColor(color) ? color : null}
          tagName={draft.trim()}
          onDone={(hex) => {
            setColor(hex)
            setPicking(false)
          }}
          onCancel={() => setPicking(false)}
        />
      ) : (
        <>
          <input
            ref={field}
            className="pick-filter quick-tag-field"
            type="text"
            role="combobox"
            aria-label={t('quickTag.field')}
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows[active] ? optionId(active) : undefined}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={t('quickTag.placeholder')}
            value={draft}
            {...limit}
          />
          <ul
            id={listId}
            className="picker-list"
            role="listbox"
            aria-label={t('note.tagSuggestions')}
          >
            {rows.map((row, i) => (
              <li
                key={row.kind === 'tag' ? row.tag.id : 'create'}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className="picker-option"
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setActive(i)}
                onClick={() => apply(row)}
              >
                {row.kind === 'tag' ? (
                  <>
                    {row.tag.color ? (
                      <TagDot color={row.tag.color} name={row.tag.name} />
                    ) : (
                      <span
                        className={tagDotClass(null)}
                        data-lowercase={dotCase(row.tag.name)}
                        aria-hidden="true"
                      />
                    )}
                    <span className="picker-name" dir="auto">
                      {row.tag.name}
                    </span>
                    <span className="picker-key">
                      {(props.counts.get(row.tag.id) ?? 0).toLocaleString(currentLocale())}
                    </span>
                  </>
                ) : (
                  <span className="picker-name" dir="auto">
                    {format(t('note.createTag'), { name: row.name })}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {rows.length === 0 ? <p className="picker-empty">{t('quickTag.empty')}</p> : null}
          {creating ? (
            <div onMouseDown={(e) => e.preventDefault()}>
              <ColorSwatches
                value={color}
                onChange={setColor}
                label={t('tagMenu.color')}
                noneLabel={t('tagColor.none')}
                onCustom={() => setPicking(true)}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
