import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { BookRecord, DiffBlock, HistoryEntry } from '../../core'
import { NOTE_STATUSES, type NoteStatus } from '../../core/storage'
import { errorCode } from './backups'
import { useMenuEvent } from './commands/dispatch'
import type { Core } from './core-client'
import { countOf } from './format'
import { displayTitle, displayTitles } from './headlines'
import { currentLocale, format, t } from './i18n'

const entryId = (i: number) => `history-entry-${i}`

export const SHOW_HISTORY = 'devot:show-history'

export function useHistoryMenu(open: () => void) {
  useMenuEvent('devot://show-history', SHOW_HISTORY, open)
}

const when = (at: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at)

function describeChange(entry: Extract<HistoryEntry, { kind: 'body' }>, locale: string): string {
  // The oldest kept version: nothing before it to count a change from.
  if (entry.change === null)
    return countOf(entry.length, locale, 'history.earliestOne', 'history.earliestOther')
  if (entry.change === 0) return t('history.sameLength')
  return entry.change > 0
    ? countOf(entry.change, locale, 'history.addedOne', 'history.addedOther')
    : countOf(-entry.change, locale, 'history.removedOne', 'history.removedOther')
}

function describe(entry: HistoryEntry, books: BookRecord[], locale: string): string {
  if (entry.kind === 'body' && entry.merge) {
    return format(t('history.beforeMerge'), {
      change: describe({ ...entry, merge: false }, books, locale),
    })
  }
  switch (entry.kind) {
    case 'body': {
      const change = describeChange(entry, locale)
      return entry.ai ? format(t('history.aiEdit'), { change }) : change
    }
    case 'title':
      return format(t('history.renamed'), { title: entry.value || t('note.untitled') })
    case 'book': {
      if (entry.value === null) return t('history.movedOut')
      const book = books.find((b) => b.id === entry.value)
      return book ? format(t('history.moved'), { notebook: book.name }) : t('history.movedDeleted')
    }
    case 'status': {
      const status: NoteStatus = NOTE_STATUSES.find((s) => s === entry.value) ?? 'none'
      return format(t('history.status'), { status: t(`status.${status}`) })
    }
    case 'pinned':
      return t(entry.value === '1' ? 'history.pinned' : 'history.unpinned')
  }
}

/**
 * The Revision History sheet: the note's versions and metadata events,
 * newest first. Picking a version shows how the note changed since; Restore
 * makes the note that version again (one undoable edit).
 */
export function RevisionHistory(props: {
  core: Core
  noteId: string
  title: string
  books: BookRecord[]
  onRestore: (update: Uint8Array) => void
  onClose: () => void
}) {
  const { core, noteId } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [entries, setEntries] = useState<HistoryEntry[]>()
  const [active, setActive] = useState(0)
  const [diff, setDiff] = useState<{ id: string; blocks: DiffBlock[] }>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const locale = currentLocale()
  const [named, setNamed] = useState<string>()
  useEffect(() => {
    let current = true
    void displayTitles((ids) => core.headlines(ids), [{ id: noteId, title: props.title }]).then(
      (found) => current && setNamed(found.get(noteId)),
    )
    return () => {
      current = false
    }
  }, [core, noteId, props.title])

  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    list.current?.focus()
    return () => el?.close()
  }, [])

  useEffect(() => {
    let current = true
    core.history(noteId).then(
      (found) => current && setEntries(found),
      (e: unknown) => current && setError(format(t('history.failed'), { code: errorCode(e) })),
    )
    return () => {
      current = false
    }
  }, [core, noteId])

  const selected = entries?.[Math.min(active, entries.length - 1)]
  const versionId = selected?.kind === 'body' ? selected.id : undefined

  useEffect(() => {
    if (versionId === undefined) return
    let current = true
    core.compareRevision(noteId, versionId).then(
      (blocks) => current && setDiff({ id: versionId, blocks }),
      (e: unknown) => current && setError(format(t('history.failed'), { code: errorCode(e) })),
    )
    return () => {
      current = false
    }
  }, [core, noteId, versionId])

  useEffect(() => {
    document.getElementById(entryId(active))?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (i: number) => {
    setActive(i)
    setError(undefined)
  }

  const blocks = diff && diff.id === versionId ? diff.blocks : undefined
  const changed = blocks?.some((b) => b.kind === 'added' || b.kind === 'removed') ?? false

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!entries || entries.length === 0) return
    const last = entries.length - 1
    const next =
      e.key === 'ArrowDown'
        ? Math.min(last, active + 1)
        : e.key === 'ArrowUp'
          ? Math.max(0, active - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : undefined
    if (next === undefined) return
    e.preventDefault()
    pick(next)
  }

  const restore = async () => {
    if (versionId === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      props.onRestore(await core.restoreRevision(noteId, versionId))
    } catch (e) {
      setError(format(t('history.restoreFailed'), { code: errorCode(e) }))
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="sheet history"
      aria-labelledby="history-title"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) props.onClose()
      }}
      // WebKit stops honouring preventDefault after a few Escapes in a row
      // and closes the dialog itself: reopen it while busy, else tell App.
      // (A close queued before the dialog was shown again is stale.)
      onClose={(e) => {
        if (e.target !== e.currentTarget || dialog.current?.open) return
        if (busy) dialog.current?.showModal()
        else props.onClose()
      }}
    >
      <h2 id="history-title" className="sheet-title">
        {t('history.title')}
      </h2>
      <p className="sheet-detail">
        {format(t('history.detail'), { title: named ?? displayTitle(props.title, undefined) })}
      </p>
      {error ? (
        <p role="alert" className="sheet-error">
          {error}
        </p>
      ) : null}
      <div className="history-body">
        <ul
          ref={list}
          className="history-list"
          role="listbox"
          tabIndex={0}
          aria-label={t('history.versions')}
          aria-activedescendant={selected ? entryId(active) : undefined}
          onKeyDown={onKeyDown}
        >
          {entries?.map((entry, i) => (
            <li
              key={entry.id}
              id={entryId(i)}
              className="history-row"
              role="option"
              aria-selected={i === active}
              data-kind={entry.kind === 'body' ? 'version' : 'event'}
              onClick={() => pick(i)}
            >
              <span className="history-when">{when(entry.at, locale)}</span>
              <span className="history-what">{describe(entry, props.books, locale)}</span>
            </li>
          ))}
        </ul>
        <section className="history-diff" aria-label={t('history.changes')}>
          {entries && entries.length === 0 ? (
            <p className="sheet-detail">{t('history.empty')}</p>
          ) : selected && selected.kind !== 'body' ? (
            <p className="sheet-detail">{t('history.eventDetail')}</p>
          ) : blocks && !changed ? (
            <p className="sheet-detail">{t('history.noChanges')}</p>
          ) : blocks ? (
            <>
              <p className="sheet-detail">{t('history.since')}</p>
              <div className="diff">
                {blocks.map((block, i) =>
                  block.kind === 'skipped' ? (
                    <div key={i} className="diff-skipped">
                      {countOf(block.count, locale, 'history.skippedOne', 'history.skippedOther')}
                    </div>
                  ) : (
                    <div key={i} className={`diff-line diff-${block.kind}`}>
                      <span className="diff-mark" aria-hidden="true">
                        {block.kind === 'added' ? '+' : block.kind === 'removed' ? '−' : ''}
                      </span>
                      {block.kind === 'added' ? (
                        <ins>{block.text}</ins>
                      ) : block.kind === 'removed' ? (
                        <del>{block.text}</del>
                      ) : (
                        <span>{block.text}</span>
                      )}
                    </div>
                  ),
                )}
              </div>
            </>
          ) : null}
        </section>
      </div>
      <div className="confirm-actions">
        <button
          type="button"
          className="button"
          disabled={busy || !changed}
          onClick={() => void restore()}
        >
          {t('history.restore')}
        </button>
        <button type="button" className="button" disabled={busy} onClick={props.onClose}>
          {t('history.done')}
        </button>
      </div>
    </dialog>
  )
}
