import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import {
  CATEGORY_ICONS,
  CATEGORY_LUCIDE_GLYPHS,
  lucideGlyphOf,
  NOTEBOOK_ICON_CATEGORIES,
  notebookIcon,
  notebookIconSet,
  searchNotebookSymbols,
  symbolsInCategory,
  type NotebookIconCategory,
  type NotebookIconSet,
} from '../../core/notebookIcons'
import type { TagColor } from '../../core/storage'
import { bookIconClass } from './BookIcon'
import { t, type MessageKey } from './i18n'
import { isImeKey } from './ime'
import { useEditorSetting } from './editorSettings'
import { loadNotebookGlyphs, NotebookLucideIcon, preloadSymbols, SymbolIcon } from './icons/Icon'
import { useSegmentSlide } from './segmentSlide'
import { ColorSwatches } from './ColorSwatches'
import { columnsOf, gridStep } from './iconGrid'

export const ICON_SEARCH_DELAY = 300

const ICON_SETS: readonly { id: NotebookIconSet; label: MessageKey }[] = [
  { id: 'sfSymbols', label: 'appearanceSettings.iconStyleSfSymbols' },
  { id: 'lucide', label: 'appearanceSettings.iconStyleLucide' },
]

const categoryLabel = (id: NotebookIconCategory) => t(`notebookIcon.category.${id}` as MessageKey)

/**
 * Change Notebook Icon: a search field, a choice of icon set, a tab per category
 * and a grid of that set's catalog, with a row of palette colours the grid is drawn in.
 * Picking a symbol applies it in the chosen colour and closes; Revert to
 * Default takes the icon and colour off; Escape or Cancel leaves them.
 */
export function NotebookIconDialog(props: {
  book: { name: string; icon: string | null; iconColor: TagColor | null }
  onPick: (icon: string, color: TagColor | null) => void
  onRevert: () => void
  onCancel: () => void
}) {
  const { book } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const gridBox = useRef<HTMLDivElement>(null)
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<NotebookIconCategory>(
    () => (book.icon ? notebookIcon(book.icon)?.category : undefined) ?? 'people',
  )
  const appIconStyle = useEditorSetting('iconStyle')
  const [iconSet, setIconSet] = useState<NotebookIconSet>(() =>
    book.icon && notebookIcon(book.icon) ? notebookIconSet(book.icon) : appIconStyle,
  )
  const setGroup = useRef<HTMLDivElement>(null)
  useSegmentSlide(
    setGroup,
    ICON_SETS.findIndex((s) => s.id === iconSet),
  )
  useEffect(() => {
    if (iconSet === 'lucide') loadNotebookGlyphs().catch(() => {})
  }, [iconSet])
  const [color, setColor] = useState<TagColor | null>(book.iconColor)
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  const search = (next: string) => {
    setQuery(next)
    gridBox.current?.scrollTo?.({ top: 0 })
  }

  useEffect(() => {
    if (text === query) return
    const timer = setTimeout(() => {
      setQuery(text)
      gridBox.current?.scrollTo?.({ top: 0 })
    }, ICON_SEARCH_DELAY)
    return () => clearTimeout(timer)
  }, [text, query, gridBox])

  const searching = query.trim() !== ''
  const shown = searching
    ? searchNotebookSymbols(query, iconSet)
    : symbolsInCategory(category, iconSet)
  const tabStop = Math.max(
    0,
    shown.findIndex((s) => s.name === book.icon),
  )

  const pickTab = (id: NotebookIconCategory) => {
    setText('')
    setCategory(id)
    search('')
  }

  const pickSet = (next: NotebookIconSet) => {
    setIconSet(next)
    gridBox.current?.scrollTo?.({ top: 0 })
  }

  const preloadCategory = (id: NotebookIconCategory) =>
    iconSet === 'sfSymbols' &&
    preloadSymbols(
      symbolsInCategory(id).map((s) => s.name),
      'lg',
    )

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cells = [...(grid.current?.children ?? [])] as HTMLElement[]
    const at = cells.indexOf(document.activeElement as HTMLElement)
    if (at === -1) return
    const next = gridStep(e.key, at, cells.length, columnsOf(grid.current))
    if (next === undefined) return
    e.preventDefault()
    cells[next]?.focus()
  }

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = NOTEBOOK_ICON_CATEGORIES.indexOf(category)
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const n = NOTEBOOK_ICON_CATEGORIES.length
    const next = NOTEBOOK_ICON_CATEGORIES[(at + step + n) % n]!
    pickTab(next)
    e.currentTarget.querySelector<HTMLElement>(`[data-category="${next}"]`)?.focus()
  }

  return (
    <dialog
      ref={dialog}
      className="sheet notebook-icon"
      aria-labelledby="notebook-icon-title"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <h2 id="notebook-icon-title" className="sheet-title">
        {t('notebookIcon.title')}
      </h2>
      <p className="sheet-detail">{book.name}</p>
      <input
        className="pick-filter"
        type="search"
        aria-label={t('notebookIcon.search')}
        placeholder={t('notebookIcon.search')}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isImeKey(e.nativeEvent)) return
          if (e.key === 'Enter') {
            e.preventDefault()
            search(text)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            // The grid shows what was typed before it takes the keyboard.
            if (text !== query) flushSync(() => search(text))
            ;(grid.current?.firstElementChild as HTMLElement | null)?.focus()
          }
        }}
      />
      <div
        ref={setGroup}
        className="segmented icon-sets"
        role="group"
        aria-label={t('notebookIcon.set')}
      >
        {ICON_SETS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="segment"
            aria-pressed={iconSet === s.id}
            onClick={() => pickSet(s.id)}
          >
            {t(s.label)}
          </button>
        ))}
      </div>
      <div
        role="tablist"
        aria-label={t('notebookIcon.categories')}
        className="icon-tabs"
        onKeyDown={onTabKey}
      >
        {NOTEBOOK_ICON_CATEGORIES.map((id) => {
          const selected = !searching && id === category
          return (
            <button
              key={id}
              type="button"
              role="tab"
              className="icon-tab"
              data-category={id}
              aria-selected={selected}
              tabIndex={id === category ? 0 : -1}
              aria-label={categoryLabel(id)}
              title={categoryLabel(id)}
              onClick={() => pickTab(id)}
              onPointerEnter={() => preloadCategory(id)}
              onFocus={() => preloadCategory(id)}
            >
              {iconSet === 'lucide' ? (
                <NotebookLucideIcon glyph={CATEGORY_LUCIDE_GLYPHS[id]} size="md" />
              ) : (
                <SymbolIcon symbol={CATEGORY_ICONS[id]} size="md" />
              )}
            </button>
          )
        })}
      </div>
      <div className="icon-grid-box" ref={gridBox}>
        {shown.length > 0 ? (
          <div
            ref={grid}
            role="group"
            aria-label={searching ? t('notebookIcon.results') : categoryLabel(category)}
            className="icon-grid"
            onKeyDown={onGridKey}
          >
            {shown.map((s, i) => {
              const glyph = lucideGlyphOf(s.name)
              const label = glyph ?? s.name
              return (
                <button
                  key={s.name}
                  type="button"
                  // Tab stops once in the grid: on the current icon, else the
                  // first; the arrow keys move inside it.
                  tabIndex={i === tabStop ? 0 : -1}
                  className="icon-cell"
                  data-symbol={s.name}
                  aria-label={label}
                  aria-pressed={s.name === book.icon}
                  title={label}
                  onClick={() => props.onPick(s.name, color)}
                >
                  {glyph === null ? (
                    <SymbolIcon symbol={s.name} size="lg" lazy className={bookIconClass(color)} />
                  ) : (
                    <NotebookLucideIcon glyph={glyph} size="lg" className={bookIconClass(color)} />
                  )}
                </button>
              )
            })}
          </div>
        ) : (
          <p className="icon-grid-empty">{t('notebookIcon.none')}</p>
        )}
      </div>
      <ColorSwatches
        value={color}
        onChange={setColor}
        label={t('notebookIcon.color')}
        noneLabel={t('notebookIcon.noColor')}
      />
      <div className="confirm-actions icon-actions">
        <button type="button" className="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
        {/* Never disabled: an icon from a later catalog reads as none here
            and still needs a way back to the default. */}
        <button type="button" className="button" onClick={props.onRevert}>
          {t('notebookIcon.revert')}
        </button>
      </div>
    </dialog>
  )
}
