import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { inlineDiff, type TextSegment } from '../../core/diff'
import { errorCode } from '../../core/errors'
import type { Core } from './core-client'
import {
  axisAt,
  compactionLimited,
  historySteps,
  pastOffset,
  removedWithin,
  scrubKey,
  stepNearest,
  tickHeight,
  type HistoryStep,
} from './historySteps'
import { currentLocale, format, t } from './i18n'
import { describeChange } from './RevisionHistory'
import { useText, type TextStore } from './textStore'

// A press that moves less than this is a click: it keeps the version it picked on screen.
const CLICK_SLOP_PX = 4

const when = (at: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at)

function stepText(step: HistoryStep | undefined, locale: string): string {
  if (!step) return t('historyBar.now')
  return format(t('activity.day'), {
    date: when(step.at, locale),
    totals: describeChange({ ...step, kind: 'body', merge: false }, locale),
  })
}

type Mode = 'idle' | 'drag' | 'pinned'

interface Shown {
  noteId: string
  /** The version shown, or null for the current text. */
  id: string | null
  mode: Mode
}

/** The version shown in place. */
interface Past {
  id: string
  at: number
  text: string
}

function pointIn(
  root: HTMLElement,
  node: Node,
  offset: number,
  segments: readonly TextSegment[],
  length: number,
): number | undefined {
  if (!root.contains(node)) return undefined
  if (node === root) {
    return offset >= segments.length ? length : pastOffset(segments, offset, 0)
  }
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  const segment = element?.closest<HTMLElement>('[data-segment]')
  if (!segment) return undefined
  const index = Number(segment.dataset['segment'])
  const within =
    node.nodeType === Node.TEXT_NODE
      ? offset
      : offset === 0
        ? 0
        : (segments[index]?.text.length ?? 0)
  return pastOffset(segments, index, within)
}

function HistoryOverlay(props: {
  past: Past
  text: TextStore
  locale: string
  onPassage: (range: { from: number; to: number } | undefined) => void
}) {
  const current = useText(props.text)
  const segments = useMemo(() => inlineDiff(props.past.text, current), [props.past.text, current])
  const root = useRef<HTMLDivElement>(null)
  const { onPassage } = props
  const length = props.past.text.length

  useEffect(() => {
    const read = () => {
      const el = root.current
      const selection = document.getSelection()
      if (!el || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return onPassage(undefined)
      }
      const range = selection.getRangeAt(0)
      const a = pointIn(el, range.startContainer, range.startOffset, segments, length)
      const b = pointIn(el, range.endContainer, range.endOffset, segments, length)
      if (a === undefined || b === undefined) return onPassage(undefined)
      const from = Math.min(a, b)
      const to = Math.max(a, b)
      onPassage(removedWithin(segments, from, to) ? { from, to } : undefined)
    }
    read()
    document.addEventListener('selectionchange', read)
    return () => document.removeEventListener('selectionchange', read)
  }, [segments, length, onPassage])

  useEffect(() => {
    root.current?.querySelector('del, ins')?.scrollIntoView({ block: 'nearest' })
  }, [props.past.id])

  return (
    <div
      className="history-overlay"
      role="region"
      aria-label={format(t('historyBar.overlay'), { date: when(props.past.at, props.locale) })}
      tabIndex={-1}
    >
      <div ref={root} className="history-overlay-text">
        {segments.map((s, i) =>
          s.kind === 'removed' ? (
            <del key={i} data-segment={i}>
              {s.text}
            </del>
          ) : s.kind === 'added' ? (
            <ins key={i} data-segment={i}>
              {s.text}
            </ins>
          ) : (
            <span key={i} data-segment={i} className="history-same">
              {s.text}
            </span>
          ),
        )}
      </div>
    </div>
  )
}

/**
 * View > Show History Bar: the open note's kept versions as ticks on a time axis along the editor's bottom edge. Dragging the handle (or its arrow keys)
 * shows a version in place over the editor, a read-only overlay of the current text with what changed since; the note itself is left alone, and what
 * changes it meanwhile (sync, devot-mcp) shows under the overlay. Letting go or Escape returns; a click or a key keeps the version shown, so struck text
 * can be selected and put back.
 */
export function useHistoryBar(props: {
  core: Core | undefined
  noteId: string | undefined
  /** The note's last change: new versions are read when it moves. */
  updatedAt: number | undefined
  text: TextStore
  enabled: boolean
  readOnly: boolean
  onApply: (update: Uint8Array) => void
}): { bar: ReactNode; overlay: ReactNode } {
  const { core, noteId, enabled } = props
  const locale = currentLocale()
  const [steps, setSteps] = useState<{ noteId: string; steps: HistoryStep[] }>()
  const [error, setError] = useState<string>()
  const [shown, setShown] = useState<Shown>()
  const [texts, setTexts] = useState(() => new Map<string, string>())
  const [passage, setPassage] = useState<{ from: number; to: number }>()
  const [busy, setBusy] = useState(false)
  const [past, setPast] = useState<Past>()
  const [reload, setReload] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const handle = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const press = useRef<{ x: number; moved: boolean } | undefined>(undefined)

  useEffect(() => {
    if (!core || !noteId || !enabled) return
    let current = true
    core.history(noteId).then(
      (entries) => {
        if (!current) return
        setSteps({ noteId, steps: historySteps(entries) })
        setNow(Date.now())
        setError(undefined)
      },
      (e: unknown) => current && setError(errorCode(e)),
    )
    return () => {
      current = false
    }
  }, [core, noteId, enabled, props.updatedAt, reload])

  const list = steps && steps.noteId === noteId ? steps.steps : []
  const atNote = shown && shown.noteId === noteId ? shown : undefined
  const index = atNote?.id ? list.findIndex((s) => s.id === atNote.id) : -1
  const value = index === -1 ? list.length : index
  const step = list[value]
  const showing = enabled && step !== undefined && atNote !== undefined && atNote.mode !== 'idle'

  useEffect(() => {
    if (!core || !noteId || !showing || texts.has(step.id)) return
    let current = true
    core.revisionText(noteId, step.id).then(
      (text) => current && setTexts((before) => new Map(before).set(step.id, text)),
      (e: unknown) => current && setError(errorCode(e)),
    )
    return () => {
      current = false
    }
  }, [core, noteId, showing, step, texts])

  const [textsFor, setTextsFor] = useState(noteId)
  if (textsFor !== noteId) {
    setTextsFor(noteId)
    setTexts(new Map())
    setPassage(undefined)
  }

  const show = (i: number, mode: Mode) => {
    if (!noteId) return
    const id = list[i]?.id ?? null
    setShown({ noteId, id, mode: id === null ? 'idle' : mode })
    if (id !== atNote?.id) setPassage(undefined)
  }
  const back = () => {
    if (noteId) setShown({ noteId, id: null, mode: 'idle' })
    setPassage(undefined)
  }

  useEffect(() => {
    if (!showing) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      back()
      handle.current?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const loaded = showing ? texts.get(step.id) : undefined
  // While the next version is read, the one before stays on screen rather than the overlay blinking off.
  if (!showing && past !== undefined) setPast(undefined)
  else if (showing && loaded !== undefined && past?.id !== step.id) {
    setPast({ id: step.id, at: step.at, text: loaded })
  }
  if (!enabled && shown !== undefined) setShown(undefined)
  if (!enabled || !noteId) return { bar: null, overlay: null }

  const start = list[0]?.at ?? now
  const end = Math.max(now, list.at(-1)?.at ?? now)
  const most = Math.max(0, ...list.map((s) => s.chars))
  const at = (x: number) => {
    const box = track.current?.getBoundingClientRect()
    if (!box || box.width === 0) return 1
    return (x - box.left) / box.width
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || list.length === 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    press.current = { x: e.clientX, moved: false }
    handle.current?.focus()
    setNow(Date.now())
    show(stepNearest(at(e.clientX), list, start, end), 'drag')
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (!p) return
    if (Math.abs(e.clientX - p.x) >= CLICK_SLOP_PX) p.moved = true
    show(stepNearest(at(e.clientX), list, start, end), 'drag')
  }
  const onPointerUp = () => {
    const p = press.current
    press.current = undefined
    if (!p) return
    if (p.moved) back()
    else show(value, 'pinned')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = scrubKey(e.key, value, list.length)
    if (next === undefined) return
    e.preventDefault()
    show(next, 'pinned')
  }

  const restorePassage = async () => {
    if (!core || !step || !passage) return
    setBusy(true)
    try {
      props.onApply(await core.restorePassage(noteId, step.id, passage))
      back()
      setReload((n) => n + 1)
    } catch (e) {
      setError(errorCode(e))
    } finally {
      setBusy(false)
    }
  }
  const restoreWhole = async () => {
    if (!core || !step) return
    setBusy(true)
    try {
      props.onApply(await core.restoreRevision(noteId, step.id))
      back()
      setReload((n) => n + 1)
    } catch (e) {
      setError(errorCode(e))
    } finally {
      setBusy(false)
    }
  }

  const note = error
    ? format(t('historyBar.failed'), { code: error })
    : list.length === 0
      ? t('history.empty')
      : compactionLimited(list, now)
        ? t('historyBar.compacted')
        : t('historyBar.hint')
  const handleAt = step ? axisAt(step.at, start, end) : 1

  const bar = (
    <div className="history-bar" role="group" aria-label={t('historyBar.label')}>
      <div
        ref={track}
        className="history-track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press.current = undefined
          back()
        }}
      >
        {list.map((s, i) => (
          <span
            key={s.id}
            className="history-tick"
            aria-hidden="true"
            data-shown={showing && i === value ? '' : undefined}
            style={{
              left: `${axisAt(s.at, start, end) * 100}%`,
              height: `${tickHeight(s.chars, most) * 100}%`,
            }}
          />
        ))}
        <div
          ref={handle}
          className="history-handle"
          role="slider"
          tabIndex={0}
          aria-label={t('historyBar.slider')}
          aria-valuemin={0}
          aria-valuemax={list.length}
          aria-valuenow={value}
          aria-valuetext={stepText(showing ? step : undefined, locale)}
          aria-disabled={list.length === 0 || undefined}
          style={{ left: `${handleAt * 100}%` }}
          onKeyDown={onKeyDown}
        >
          {showing ? <span className="history-handle-date">{when(step.at, locale)}</span> : null}
        </div>
      </div>
      <div className="history-bar-row">
        <p className="history-bar-note" role={error ? 'alert' : undefined}>
          {note}
        </p>
        {showing ? (
          <span className="history-bar-actions">
            {passage ? (
              <button
                type="button"
                className="button"
                disabled={busy || props.readOnly}
                onClick={() => void restorePassage()}
              >
                {t('historyBar.restorePassage')}
              </button>
            ) : null}
            <button
              type="button"
              className="button"
              disabled={busy || props.readOnly}
              onClick={() => void restoreWhole()}
            >
              {t('historyBar.restoreWhole')}
            </button>
          </span>
        ) : null}
      </div>
    </div>
  )
  const overlay =
    past !== undefined ? (
      <HistoryOverlay past={past} text={props.text} locale={locale} onPassage={setPassage} />
    ) : null
  return { bar, overlay }
}
