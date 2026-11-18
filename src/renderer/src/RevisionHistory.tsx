import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { BookRecord, DiffBlock, HistoryEntry } from '../../core'
import { NOTE_STATUSES, type NoteStatus } from '../../core/storage'
import { errorCode } from './backups'
import { describeChange } from './historyChange'
import type { Core } from './core-client'
import { countOf } from './format'
import { displayTitle, displayTitles } from './headlines'
import { currentLocale, format, t } from './i18n'
import { failureText, logFailure } from './failure'

const when = (at: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at)

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

type Load<T> = { kind: 'ready'; value: T } | { kind: 'failed'; message: string }
type Restore = { kind: 'idle' } | { kind: 'restoring' } | { kind: 'failed'; message: string }

/**
 * The Revision History sheet, or the inspector's History tab (`inline`): the note's versions and
 * metadata events, newest first. Picking a version shows how the note changed since; Restore makes
 * the note that version again (one undoable edit). A hidden tab (`shown` false) fetches nothing and
 * reads the versions again when it shows.
 */
export function RevisionHistory(props: {
  core: Core
  noteId: string
  title: string
  books: BookRecord[]
  onRestore: (update: Uint8Array) => void
  onClose?: () => void
  inline?: boolean
  updatedAt?: number | undefined
  shown?: boolean
  readOnly?: boolean
}) {
  const { core, noteId } = props
  const shown = props.shown ?? true
  const prefix = useId()
  const entryId = (i: number) => `${prefix}-entry-${i}`
  const [revision, refresh] = useState(0)
  const restoreRequest = useRef({ sequence: 0 })
  const listRequest = useRef({ sequence: 0 })
  const diffRequest = useRef({ sequence: 0 })
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [versions, setVersions] = useState<Load<HistoryEntry[]>>()
  const entries = versions?.kind === 'ready' ? versions.value : undefined
  const [activeId, setActiveId] = useState<string>()
  const [diff, setDiff] = useState<{
    id: string
    revision: number
    updatedAt: number | undefined
    result: Load<DiffBlock[]>
  }>()
  const [restoring, setRestoring] = useState<Restore>({ kind: 'idle' })
  const busy = restoring.kind === 'restoring'
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
    const restoreGuard = restoreRequest.current
    const el = dialog.current
    if (el && !el.open) el.showModal()
    if (el) list.current?.focus()
    return () => {
      restoreGuard.sequence++
      el?.close()
    }
  }, [])

  useEffect(() => {
    if (!shown) return
    const listGuard = listRequest.current
    const request = ++listGuard.sequence
    core.history(noteId).then(
      (found) => request === listGuard.sequence && setVersions({ kind: 'ready', value: found }),
      (e: unknown) =>
        request === listGuard.sequence &&
        setVersions({
          kind: 'failed',
          message: failureText('history.failed', logFailure(errorCode(e), 'W_HISTORY_FAILED')),
        }),
    )
    return () => {
      listGuard.sequence++
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A saved edit or restore changes the version list.
  }, [core, noteId, revision, props.updatedAt, shown])

  const active = Math.max(0, entries?.findIndex((entry) => entry.id === activeId) ?? 0)
  const selected = entries?.[active]
  const versionId = selected?.kind === 'body' ? selected.id : undefined

  useEffect(() => {
    if (versionId === undefined || !shown) return
    const diffGuard = diffRequest.current
    const request = ++diffGuard.sequence
    const receive = (result: Load<DiffBlock[]>) => {
      if (request === diffGuard.sequence)
        setDiff({ id: versionId, revision, updatedAt: props.updatedAt, result })
    }
    core.compareRevision(noteId, versionId).then(
      (blocks) => receive({ kind: 'ready', value: blocks }),
      (e: unknown) =>
        receive({
          kind: 'failed',
          message: failureText('history.failed', logFailure(errorCode(e), 'W_HISTORY_FAILED')),
        }),
    )
    return () => {
      diffGuard.sequence++
    }
  }, [core, noteId, versionId, revision, props.updatedAt, shown])

  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (i: number) => {
    if (busy) return
    setActiveId(entries?.[i]?.id)
    setRestoring({ kind: 'idle' })
  }

  const comparison =
    diff &&
    diff.id === versionId &&
    diff.revision === revision &&
    diff.updatedAt === props.updatedAt
      ? diff.result
      : undefined
  const blocks = comparison?.kind === 'ready' ? comparison.value : undefined
  const error =
    restoring.kind === 'failed'
      ? restoring.message
      : versions?.kind === 'failed'
        ? versions.message
        : comparison?.kind === 'failed'
          ? comparison.message
          : undefined
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
    if (versionId === undefined || busy) return
    const request = ++restoreRequest.current.sequence
    setRestoring({ kind: 'restoring' })
    try {
      const update = await core.restoreRevision(noteId, versionId)
      props.onRestore(update)
      if (restoreRequest.current.sequence !== request) return
      props.onClose?.()
      setRestoring({ kind: 'idle' })
      refresh((n) => n + 1)
    } catch (e) {
      if (restoreRequest.current.sequence !== request) return
      setRestoring({
        kind: 'failed',
        message: failureText('history.restoreFailed', logFailure(errorCode(e), 'W_HISTORY_FAILED')),
      })
    }
  }

  const content = (
    <>
      <h2 id={prefix} className="sheet-title">
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
        <section className="history-diff" aria-label={t('history.changes')} tabIndex={0}>
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
          disabled={busy || !changed || props.readOnly}
          onClick={() => void restore()}
        >
          {t('history.restore')}
        </button>
        {!props.inline && (
          <button type="button" className="button" disabled={busy} onClick={props.onClose}>
            {t('history.done')}
          </button>
        )}
      </div>
    </>
  )
  if (props.inline) return <div className="inspector-history">{content}</div>
  return (
    <dialog
      ref={dialog}
      className="sheet history"
      aria-labelledby={prefix}
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) props.onClose?.()
      }}
      // WebKit stops honouring preventDefault after a few Escapes in a row
      // and closes the dialog itself: reopen it while busy, else tell App.
      // (A close queued before the dialog was shown again is stale.)
      onClose={(e) => {
        if (e.target !== e.currentTarget || dialog.current?.open) return
        if (busy) dialog.current?.showModal()
        else props.onClose?.()
      }}
    >
      {content}
    </dialog>
  )
}
