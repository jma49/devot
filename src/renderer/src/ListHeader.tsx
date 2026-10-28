import { useEffect, useState, type ReactNode, type Ref } from 'react'
import { listCaption } from './format'
import { currentLocale, t } from './i18n'
import { Icon } from './icons/Icon'
import type { MenuPoint } from './contextMenu'
import { isImeKey } from './ime'

export interface ListHeaderProps {
  title: string
  scope?: string | undefined
  count: number
  /** More matched than `count` (a capped search). */
  capped?: boolean | undefined
  icon?: ReactNode
  onTitleMenu?: ((at: MenuPoint) => void) | undefined
  leading?: ReactNode
  headerAction?: ReactNode
  onCreate: (() => void) | undefined
  createLabel?: string | undefined
  filter?: ReactNode
  sort?: { label: string; chip: string; onOpen: (anchor: HTMLElement) => void } | undefined
  sortButtonRef?: Ref<HTMLButtonElement> | undefined
  /** The List / Board control, for the views that can show a board. */
  layout?: ReactNode
  /** Return in the filter field: the notes take the keyboard. */
  onFilterDone: () => void
}

const STATUS_DELAY_MS = 500

/** The note list's toolbar (the view's name, New Note) and the filter row under it, for the list and the board alike. */
export function ListHeader(props: ListHeaderProps) {
  const { title, sortButtonRef } = props
  const caption = listCaption(props.count, props.scope, currentLocale(), props.capped)
  const [spoken, setSpoken] = useState(caption)
  useEffect(() => {
    const timer = setTimeout(() => setSpoken(caption), STATUS_DELAY_MS)
    return () => clearTimeout(timer)
  }, [caption])

  return (
    <>
      <div
        className="toolbar list-header"
        data-devot-part="toolbar"
        role="toolbar"
        aria-label={t('toolbar.label')}
        data-tauri-drag-region
      >
        <div className="list-header-side" data-tauri-drag-region>
          {props.leading}
        </div>
        {/* The view's name on one line, centred between the toggle and New Note.
            All of it drags the window (a double-click zooms it); the count is
            only spoken. */}
        <div
          className="toolbar-title"
          data-tauri-drag-region="deep"
          onContextMenu={
            props.onTitleMenu
              ? (e) => {
                  e.preventDefault()
                  props.onTitleMenu?.({ x: e.clientX, y: e.clientY })
                }
              : undefined
          }
        >
          {props.icon ? (
            <span className="headline-icon" aria-hidden="true">
              {props.icon}
            </span>
          ) : null}
          <span className="headline" title={title}>
            {title}
          </span>
          <span role="status" className="visually-hidden">
            {spoken}
          </span>
          {/* The count as it is now (the spoken one waits for it to settle);
              never shown. */}
          <span className="list-count" hidden>
            {caption}
          </span>
        </div>
        <div className="list-header-side list-header-end" data-tauri-drag-region>
          {props.headerAction ?? (
            <button
              type="button"
              className="tool"
              data-tauri-drag-region="false"
              aria-label={props.createLabel ?? t('noteList.newNote')}
              title={props.createLabel ?? t('noteList.newNote')}
              onClick={props.onCreate}
              disabled={!props.onCreate}
            >
              <Icon name="note.new" size="lg" />
            </button>
          )}
        </div>
      </div>
      {props.filter || props.sort || props.layout ? (
        <div
          className="list-filter"
          onKeyDown={(e) => {
            // Return in the Filter field hands the keyboard to the list (not
            // the Return that picks a candidate of an input method).
            if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return
            if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isImeKey(e.nativeEvent)) return
            e.preventDefault()
            props.onFilterDone()
          }}
        >
          {props.filter}
          {props.sort || props.layout ? (
            <div className="list-filter-tools">
              {props.sort ? (
                <button
                  ref={sortButtonRef}
                  type="button"
                  className="sort-chip"
                  aria-label={t('sort.button')}
                  title={props.sort.label}
                  onClick={(e) => props.sort?.onOpen(e.currentTarget)}
                >
                  {props.sort.chip}
                </button>
              ) : null}
              {props.layout}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
