import {
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import { errorCode } from '../../../core/errors'
import { clipTitle } from '../../../core/noteLimits'
import type { NoteStatus } from '../../../core/storage'
import { MAX_TAG_NAME_CHARS } from '../../../core/tagNames'
import { filterBooks, firstBookMatch, NO_BOOK, type BookOption } from '../BookPicker'
import { useEditorSetting } from '../editorSettings'
import { logFailure, withReason } from '../failure'
import { format, t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import { isImeKey } from '../ime'
import { invoke } from '../ipc'
import { LICENCE_REQUIRED, LICENCE_UNREADABLE, startLicence, useEditing } from '../licence'
import { useNameLimit } from '../nameLimit'
import { readNotebooks, subscribeNotebooks, type NotebookChoice } from '../notebookChoices'
import { PickerList, usePickerOpen, type PickerOption } from '../Picker'
import { StatusPicker } from '../StatusPicker'
import {
  addQuickTag,
  clearDraft,
  flushQuickTagDraft,
  isEmptyCapture,
  notebookToShow,
  readDraft,
  writeDraft,
} from './draft'
import { takePrefills, usePrefills, withPrefill, type Prefill } from './prefill'

// One string, so the store's snapshot is stable between changes.
const notebooksJson = () => JSON.stringify(readNotebooks())

function failure(code: string): MessageKey {
  if (code === LICENCE_REQUIRED) return 'quickCapture.trialEnded'
  if (code === LICENCE_UNREADABLE) return 'quickCapture.licenceUnreadable'
  if (code === 'E_BOOK_NOT_FOUND') return 'quickCapture.notebookGone'
  if (code === 'E_QUICK_CAPTURE_TIMEOUT' || code === 'E_QUICK_CAPTURE_NO_WINDOW')
    return 'quickCapture.noAnswer'
  if (code === 'E_QUICK_CAPTURE_LATE') return 'quickCapture.stillSaving'
  return 'quickCapture.saveFailed'
}

const captureFailureText = (code: string): string => {
  const key = failure(code)
  return key === 'quickCapture.saveFailed' ? withReason(t(key), code) : t(key)
}

const close = () =>
  invoke('quick_capture_close').catch((e: unknown) =>
    console.warn('W_QUICK_CAPTURE_CLOSE_FAILED', errorCode(e)),
  )

const plain = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey

function toBookOptions(notebooks: readonly NotebookChoice[]): BookOption[] {
  const stack: string[] = []
  return notebooks.map((n) => {
    stack.length = Math.max(0, n.depth)
    const ancestors = [...stack]
    stack[n.depth] = n.id
    return { id: n.id, name: n.name, depth: n.depth, ancestors, icon: null, iconColor: null }
  })
}

function NotebookChoicePicker(props: {
  notebooks: readonly NotebookChoice[]
  value: string | null
  disabled?: boolean
  onChange: (bookId: string | null) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = usePickerOpen(box)
  const [query, setQuery] = useState('')
  const shownOpen = open && !props.disabled
  const list = useMemo(() => toBookOptions(props.notebooks), [props.notebooks])
  const value =
    props.value !== null && list.some((o) => o.id === props.value) ? props.value : NO_BOOK
  const chosen = list.find((o) => o.id === value)
  const noBook = t('quickCapture.noNotebook')
  const current = chosen?.name ?? noBook
  const shown = filterBooks(list, query)
  const options: PickerOption[] = [
    ...(query.trim() === '' || noBook.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
      ? [
          {
            id: NO_BOOK,
            content: (
              <>
                <span className="picker-icon-slot" aria-hidden="true" />
                <span className="picker-name">{noBook}</span>
              </>
            ),
          },
        ]
      : []),
    ...shown.map((o) => ({
      id: o.id,
      depth: o.depth,
      content: (
        <>
          <Icon name="notebook" size="sm" />
          <span className="picker-name">{o.name}</span>
        </>
      ),
    })),
  ]
  const toggle = (next: boolean) => {
    setQuery('')
    setOpen(next)
  }
  const closeList = () => {
    toggle(false)
    button.current?.focus()
  }
  return (
    <div ref={box} className="picker">
      <button
        ref={button}
        type="button"
        className="popup book-popup"
        aria-label={format(t('note.bookValue'), { book: current })}
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={shownOpen}
        disabled={props.disabled}
        onClick={() => toggle(!shownOpen)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' || shownOpen || props.disabled) return
          e.preventDefault()
          toggle(true)
        }}
      >
        <Icon name="notebook" size="sm" />
        <span className="popup-value" title={current}>
          {current}
        </span>
        <Icon name="popup" size="xs" />
      </button>
      {shownOpen ? (
        <PickerList
          label={t('quickCapture.notebook')}
          options={options}
          value={value}
          onClose={closeList}
          onPick={(id) => {
            closeList()
            if (id !== value) props.onChange(id === NO_BOOK ? null : id)
          }}
          search={{
            placeholder: t('quickCapture.notebookSearch'),
            query,
            onQuery: setQuery,
            pick: (next) =>
              firstBookMatch(
                filterBooks(
                  [
                    {
                      id: NO_BOOK,
                      name: noBook,
                      depth: 0,
                      ancestors: [],
                      icon: null,
                      iconColor: null,
                    },
                    ...list,
                  ],
                  next,
                ),
                next,
              )?.id,
          }}
          empty={t('quickCapture.noMatchingNotebooks')}
        />
      ) : null}
    </div>
  )
}

/**
 * The quick capture window (menu bar mode, or a capture link): Glass controls
 * for title, body, notebook, status and tags. The main window's core saves
 * the note (src-tauri/src/menu_bar.rs); until it has, the draft stays here.
 */
export function QuickCapture() {
  const notebooks = JSON.parse(
    useSyncExternalStore(subscribeNotebooks, notebooksJson),
  ) as NotebookChoice[]
  const defaultNotebook = useEditorSetting('defaultNotebook')
  const [draft] = useState(readDraft)
  const [title, setTitle] = useState(draft?.title ?? '')
  const [body, setBody] = useState(draft?.body ?? '')
  // Undefined until a notebook is picked: the default notebook shows then.
  const [picked, setPicked] = useState<string | null | undefined>(draft ? draft.bookId : undefined)
  const [status, setStatus] = useState<NoteStatus>(() => draft?.status ?? 'none')
  const [tags, setTags] = useState<string[]>(() => draft?.tags ?? [])
  const [tagDraft, setTagDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const bodyField = useRef<HTMLTextAreaElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)
  const tagsRef = useRef(tags)
  const tagDraftRef = useRef(tagDraft)
  const composingRef = useRef(false)
  useInsertionEffect(() => {
    tagsRef.current = tags
    tagDraftRef.current = tagDraft
  }, [tags, tagDraft])
  const bookId = notebookToShow(
    picked,
    defaultNotebook,
    notebooks.map((n) => n.id),
  )
  const empty = isEmptyCapture({ title, body })
  // The trial is over without a licence: the draft stays here, and nothing is saved.
  const editing = useEditing()
  useEffect(() => startLicence(), [])

  useEffect(
    () => writeDraft({ title, body, bookId, status, tags }),
    [title, body, bookId, status, tags],
  )

  const fill = (from: { title: string; body: string }, prefills: readonly Prefill[]) => {
    const next = prefills.reduce(withPrefill, from)
    setTitle(next.title)
    setBody(next.body)
  }
  usePrefills((prefills) => fill({ title, body }, prefills), saving)

  const commitTags = (raw: string) => {
    const current = flushQuickTagDraft(tagsRef.current, raw)
    if (current.length !== tagsRef.current.length) {
      tagsRef.current = current
      setTags(current)
    }
    tagDraftRef.current = ''
    setTagDraft('')
    return current
  }

  const onTagInputChange = (raw: string) => {
    if (raw.includes(',')) {
      const pieces = raw.split(',')
      const remainder = pieces.pop() ?? ''
      let current = tagsRef.current
      for (const piece of pieces) current = addQuickTag(current, piece).next
      if (current.length !== tagsRef.current.length) {
        tagsRef.current = current
        setTags(current)
      }
      const nextDraft = remainder.trimStart()
      tagDraftRef.current = nextDraft
      setTagDraft(nextDraft)
      return
    }
    // Typing `#tag ` commits `#tag` inline once followed by whitespace.
    const spacedHash = /^\s*(#[^\s,]+)\s+(.*)$/.exec(raw)
    if (spacedHash) {
      const { next } = addQuickTag(tagsRef.current, spacedHash[1]!)
      if (next.length !== tagsRef.current.length) {
        tagsRef.current = next
        setTags(next)
      }
      const nextDraft = spacedHash[2] ?? ''
      tagDraftRef.current = nextDraft
      setTagDraft(nextDraft)
      return
    }
    tagDraftRef.current = raw
    setTagDraft(raw)
  }

  const tagLimit = useNameLimit(tagDraft, MAX_TAG_NAME_CHARS, (next) => {
    if (composingRef.current) {
      tagDraftRef.current = next
      setTagDraft(next)
      return
    }
    onTagInputChange(next)
  })

  const onTagKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e.nativeEvent)) return
    if (e.key === 'Enter' && plain(e) && tagDraftRef.current.trim() !== '') {
      e.preventDefault()
      commitTags(tagDraftRef.current)
    } else if (
      e.key === 'Backspace' &&
      plain(e) &&
      tagDraftRef.current === '' &&
      tagsRef.current.length > 0
    ) {
      e.preventDefault()
      setTags((prev) => {
        const next = prev.slice(0, -1)
        tagsRef.current = next
        return next
      })
    }
  }

  const cancelCapture = () => {
    // A note on its way may still be made after the window has gone, and its draft would stay.
    if (saving) return
    const finalTags =
      tagDraftRef.current.trim() !== '' ? commitTags(tagDraftRef.current) : tagsRef.current
    writeDraft({ title, body, bookId, status, tags: finalTags })
    void close()
  }

  const save = async () => {
    if (empty || saving || !editing) return
    const finalTags =
      tagDraftRef.current.trim() !== '' ? commitTags(tagDraftRef.current) : tagsRef.current
    setSaving(true)
    setError(undefined)
    try {
      await invoke('quick_capture_save', {
        capture: {
          title: clipTitle(title),
          body,
          bookId,
          ...(status !== 'none' ? { status } : {}),
          ...(finalTags.length > 0 ? { tags: finalTags } : {}),
        },
      })
    } catch (e) {
      setError(logFailure(errorCode(e, 'E_QUICK_CAPTURE_FAILED'), 'W_QUICK_CAPTURE_FAILED'))
      setSaving(false)
      return
    }
    // Emptied before the window goes, so a window that stays never sends the note twice.
    clearDraft()
    setTitle('')
    setBody('')
    setPicked(undefined)
    setStatus('none')
    tagsRef.current = []
    setTags([])
    tagDraftRef.current = ''
    setTagDraft('')
    // A link that came while saving opens a capture of its own rather than vanishing with the window.
    const more = await takePrefills()
    setSaving(false)
    if (more.length > 0) fill({ title: '', body: '' }, more)
    else void close()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (isImeKey(e.nativeEvent)) return
    if (e.key === 'Enter' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape' && plain(e)) {
      e.preventDefault()
      cancelCapture()
    }
  }

  const onTitleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !plain(e) || isImeKey(e.nativeEvent)) return
    e.preventDefault()
    bodyField.current?.focus()
  }

  return (
    <main className="quick-capture" aria-label={t('quickCapture.label')} onKeyDown={onKeyDown}>
      <div className="quick-capture-surface">
        <input
          className="quick-capture-title"
          aria-label={t('quickCapture.title')}
          placeholder={t('quickCapture.title')}
          value={title}
          readOnly={saving}
          autoFocus
          onChange={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={onTitleKeyDown}
        />
        <div className="note-meta quick-capture-meta">
          <div className="note-meta-fields" inert={saving || undefined}>
            <NotebookChoicePicker
              notebooks={notebooks}
              value={bookId}
              disabled={saving}
              onChange={setPicked}
            />
            <StatusPicker
              value={status}
              disabled={saving}
              showShortcuts={false}
              onChange={setStatus}
            />
            <div className="tag-editor" role="group" aria-label={t('quickCapture.tags')}>
              {tags.map((name) => (
                <span key={name} className="chip" dir="auto">
                  <span className="chip-label">
                    <span className="quick-capture-tag-hash" aria-hidden="true">
                      #
                    </span>
                    {name}
                  </span>
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label={format(t('quickCapture.removeTag'), { name })}
                    disabled={saving}
                    onClick={(e) => {
                      setTags((prev) => {
                        const next = prev.filter((item) => item !== name)
                        tagsRef.current = next
                        return next
                      })
                      if (e.detail === 0) tagInputRef.current?.focus()
                    }}
                  >
                    <Icon name="tag.remove" size="xs" />
                  </button>
                </span>
              ))}
              <span className="tag-field">
                <input
                  ref={tagInputRef}
                  className="tag-input quick-capture-tag-input"
                  aria-label={t('quickCapture.addTag')}
                  placeholder={t('quickCapture.addTag')}
                  value={tagDraft}
                  readOnly={saving}
                  onCompositionStart={() => {
                    composingRef.current = true
                    tagLimit.onCompositionStart()
                  }}
                  onCompositionEnd={(e) => {
                    composingRef.current = false
                    tagLimit.onCompositionEnd(e)
                  }}
                  onChange={(e) => {
                    if (
                      composingRef.current ||
                      (e.nativeEvent as { isComposing?: boolean }).isComposing
                    ) {
                      const raw = e.currentTarget.value
                      tagDraftRef.current = raw
                      setTagDraft(raw)
                      return
                    }
                    tagLimit.onChange(e)
                  }}
                  onBlur={() => {
                    if (!saving && !composingRef.current && tagDraftRef.current.trim() !== '') {
                      commitTags(tagDraftRef.current)
                    }
                  }}
                  onKeyDown={onTagKeyDown}
                />
                <span className="tag-field-short" aria-hidden="true">
                  {t('note.addTagShort')}
                </span>
              </span>
            </div>
          </div>
        </div>
        <div className="quick-capture-editor">
          <textarea
            ref={bodyField}
            className="quick-capture-body"
            aria-label={t('quickCapture.body')}
            placeholder={t('quickCapture.body')}
            value={body}
            readOnly={saving}
            onChange={(e) => setBody(e.currentTarget.value)}
          />
        </div>
        {error ? (
          <p role="alert" className="quick-capture-error">
            {captureFailureText(error)}
          </p>
        ) : editing ? null : (
          <p role="status" className="quick-capture-error" data-devot-trial-ended>
            {t('quickCapture.trialEnded')}
          </p>
        )}
        <div className="quick-capture-bar">
          <div className="quick-capture-hints" aria-hidden="true">
            <span className="quick-capture-hint">
              <kbd className="quick-capture-kbd">{t('quickCapture.saveShortcut')}</kbd>
              <span>{t('quickCapture.save')}</span>
            </span>
            <span className="quick-capture-hint">
              <kbd className="quick-capture-kbd">{t('quickCapture.cancelShortcut')}</kbd>
              <span>{t('quickCapture.cancel')}</span>
            </span>
          </div>
          <button type="button" className="button" disabled={saving} onClick={cancelCapture}>
            {t('quickCapture.cancel')}
          </button>
          <button
            type="button"
            className="button button-default"
            disabled={empty || saving || !editing}
            onClick={() => void save()}
          >
            {t('quickCapture.save')}
          </button>
        </div>
      </div>
    </main>
  )
}
