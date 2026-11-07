import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { frontMatterHead } from '../../../core/frontMatterHead'
import type { NoteFacts } from '../../../core/noteFacts'
import { propertyCount } from '../../../core/preview/propertyCount'
import { errorCode } from '../../../core/errors'
import { titleWithKey } from '../commands/titles'
import type { Core } from '../core-client'
import { placeDropdown } from '../dropdownPlacement'
import { NOTES_LOADED } from '../externalChanges'
import { useNow } from '../NoteList'
import { displayTitles } from '../headlines'
import { currentLocale, format, t } from '../i18n'
import type { FrontMatterChange } from '../preview/frontMatterApply'
import { previewNote, type PreviewNoteFields } from '../preview/Preview'
import { tallyNote } from '../noteTally'
import { useText, type TextStore } from '../textStore'
import { useNoteInfoCommand } from './command'
import type { NoteInfoData } from './infoCard'
import { NoteInfoCard, type Backlink, type SetNoteDates } from './NoteInfoCard'
import { summaryText } from './summary'

/** Typing waits this long before the summary counts again. */
const FACTS_WAIT_MS = 300

function useNoteFacts(core: Core, markdown: string, fields: PreviewNoteFields | undefined) {
  const [facts, setFacts] = useState<NoteFacts>()
  const counted = useRef(false)
  // The window passes the fields as a new object on every render: they are counted again only when they change.
  const fieldsKey = fields ? JSON.stringify(fields) : ''
  useEffect(() => {
    let current = true
    const note = fieldsKey ? previewNote(JSON.parse(fieldsKey) as PreviewNoteFields) : undefined
    const timer = setTimeout(
      () => {
        // The counts footer asks for the same tally, so the note crosses to the worker once (noteTally.ts).
        const head = frontMatterHead(markdown)
        Promise.all([
          tallyNote(core, markdown),
          head === null ? null : core.noteFrontMatter(head, note, t('note.untitled')),
        ]).then(
          ([tally, frontMatter]) => {
            counted.current = true
            if (current) setFacts({ tasks: tally.tasks, words: tally.words, frontMatter })
          },
          (e: unknown) => console.warn('W_NOTE_FACTS_FAILED', errorCode(e)),
        )
      },
      counted.current ? FACTS_WAIT_MS : 0,
    )
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [core, markdown, fieldsKey])
  return facts
}

/** The notes that link to `noteId`, asked again when the library changes and through the `reload` it returns. */
function useBacklinks(core: Core, noteId: string) {
  const [backlinks, setBacklinks] = useState<Backlink[]>()
  const reload = useRef(() => {})
  useEffect(() => {
    let current = true
    let asked = 0
    const load = () => {
      const mine = ++asked
      core
        .backlinks(noteId)
        .then(async (notes) => {
          const names = await displayTitles((ids) => core.headlines(ids), notes)
          if (current && mine === asked) {
            setBacklinks(notes.map((n) => ({ id: n.id, name: names.get(n.id) ?? '' })))
          }
        })
        .catch((e: unknown) => console.warn('W_BACKLINKS_FAILED', noteId, errorCode(e)))
    }
    reload.current = load
    load()
    window.addEventListener(NOTES_LOADED, load)
    return () => {
      current = false
      window.removeEventListener(NOTES_LOADED, load)
    }
  }, [core, noteId])
  return { backlinks, reload: () => reload.current() }
}

export interface NoteInfoSummaryProps {
  core: Core
  info: NoteInfoData
  markdown: string
  /** The note's own fields, so its front matter shows what differs from them. */
  note?: PreviewNoteFields | undefined
  onOpenNote: (id: string) => void
  onSetDates?: SetNoteDates | undefined
  onApplyFrontMatter?: ((change: FrontMatterChange) => void) | undefined
}

/**
 * The summary at the end of the note's pill row, and the Note Info card it opens (View > Note Info
 * opens and closes it too). The card takes the keyboard as it opens and gives it back as it closes.
 */
export function NoteInfoSummary(props: NoteInfoSummaryProps) {
  const { core, info, markdown, note } = props
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const facts = useNoteFacts(core, markdown, note)
  const { backlinks, reload } = useBacklinks(core, info.noteId)
  const now = useNow()

  const show = (next: boolean) => {
    if (next) reload()
    else if (anchor.current?.contains(document.activeElement)) button.current?.focus()
    setOpen(next)
  }
  const close = () => show(false)
  const toggle = () => show(!open)
  useNoteInfoCommand(toggle)

  useLayoutEffect(() => {
    if (!open) return
    const panel = anchor.current?.querySelector<HTMLElement>(
      ':scope > .note-info-card:not([data-closing])',
    )
    const from = button.current
    if (!panel || !from) return
    const css = getComputedStyle(panel)
    const px = (name: string) => Number.parseFloat(css.getPropertyValue(name)) || 0
    const box = from.getBoundingClientRect()
    const place = placeDropdown(
      box,
      { width: panel.offsetWidth, height: panel.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      { gap: px('--space-3'), margin: px('--size-popover-margin') },
    )
    panel.dataset['side'] = place.side
    panel.style.left = `${place.shift}px`
    panel.style.setProperty('--note-info-room', `${place.room}px`)
    panel.focus()
  }, [open])

  const locale = currentLocale()
  const text = facts
    ? summaryText(
        {
          tasks: facts.tasks,
          properties: propertyCount(facts.frontMatter),
          backlinks: backlinks?.length ?? 0,
          words: facts.words,
          updatedAt: info.updatedAt,
        },
        locale,
        now,
      )
    : ''
  return (
    <span ref={anchor} className="note-info-anchor">
      <button
        ref={button}
        type="button"
        className="note-summary"
        title={titleWithKey('command.noteInfo', 'view.noteInfo')}
        aria-label={format(t('noteInfo.open'), { summary: text })}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-pending={facts ? undefined : ''}
        onClick={toggle}
      >
        {text}
      </button>
      {open ? (
        <NoteInfoCard
          info={info}
          facts={facts}
          backlinks={backlinks}
          onOpenNote={props.onOpenNote}
          onSetDates={props.onSetDates}
          onApplyFrontMatter={props.onApplyFrontMatter}
          onClose={close}
        />
      ) : null}
    </span>
  )
}

/** The summary of the note being typed: it follows the text store (textStore.ts), and nothing around it renders. */
export function LiveNoteInfoSummary({
  text,
  ...props
}: Omit<NoteInfoSummaryProps, 'markdown'> & { text: TextStore }) {
  return <NoteInfoSummary {...props} markdown={useText(text)} />
}
