// View > Show Authorship (ADR 0007): a mark beside the lines agents wrote, read from the editor
// replica's own Yjs document, which holds the records. The text is attributed once per change to
// the document, not per line drawn, and only the marks in the viewport are drawn. The marks are
// buttons outside CodeMirror's gutters, which are hidden from assistive technology, so each can
// carry its name ("Written by ...") and take the keyboard.
import { StateEffect, StateField, type Extension, type Text } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type * as Y from 'yjs'
import {
  attribute,
  writesWithWriters,
  WRITES,
  type AuthoredRun,
  type Writer,
} from '../../../core/authorship'
import { writersLabel } from '../authorshipLabels'
import { fullDate } from '../format'
import { currentLocale, format, t } from '../i18n'

/** Consecutive lines that the same writes wrote on. */
export interface MarkSegment {
  /** 1-based, inclusive. */
  fromLine: number
  toLine: number
  /** In the order they first show in the segment. */
  writeIds: readonly string[]
}

/** The lines each run touches, as the fewest segments of lines with the same writes. */
export function markSegments(
  runs: readonly AuthoredRun[],
  lineOf: (pos: number) => number,
): MarkSegment[] {
  const spans = runs
    .filter((run) => run.to > run.from)
    .map((run) => ({ from: lineOf(run.from), to: lineOf(run.to - 1), writeId: run.writeId }))
    .sort((a, b) => a.from - b.from)
  const bounds = [...new Set(spans.flatMap((s) => [s.from, s.to + 1]))].sort((a, b) => a - b)
  const segments: MarkSegment[] = []
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const fromLine = bounds[i]!
    const toLine = bounds[i + 1]! - 1
    const writeIds = [
      ...new Set(spans.filter((s) => s.from <= fromLine && s.to >= fromLine).map((s) => s.writeId)),
    ]
    if (writeIds.length === 0) continue
    const last = segments[segments.length - 1]
    if (last && last.toLine + 1 === fromLine && sameIds(last.writeIds, writeIds)) {
      last.toLine = toLine
    } else segments.push({ fromLine, toLine, writeIds })
  }
  return segments
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id))

/** The agents' text on a segment's lines, from its first character to its last. */
export function segmentRange(
  segment: MarkSegment,
  runs: readonly AuthoredRun[],
  doc: Text,
): { from: number; to: number } | null {
  const start = doc.line(segment.fromLine).from
  const end = doc.line(segment.toLine).to
  const inside = runs.filter((r) => r.to > start && r.from <= end)
  if (inside.length === 0) return null
  return {
    from: Math.max(start, Math.min(...inside.map((r) => r.from))),
    to: Math.min(Math.max(...inside.map((r) => r.to)), doc.length),
  }
}

export interface WriteInfo {
  writer: Writer
  at: number
}

/** "Written by Claude Code (MCP), <time>": the writers of the segment and the newest write's time. */
export function markLabel(
  segment: MarkSegment,
  writes: ReadonlyMap<string, WriteInfo>,
  locale: string,
): string {
  const known = segment.writeIds.flatMap((id) => writes.get(id) ?? [])
  const newest = Math.max(...known.map((w) => w.at))
  return format(t('authorship.mark'), {
    writers: writersLabel(known.map((w) => w.writer)),
    time: fullDate(newest, locale),
  })
}

interface Authored {
  runs: readonly AuthoredRun[]
  writes: ReadonlyMap<string, WriteInfo>
  segments: readonly MarkSegment[]
}

const NONE: Authored = { runs: [], writes: new Map(), segments: [] }

const setAuthored = StateEffect.define<Omit<Authored, 'segments'>>()

const withSegments = (value: Omit<Authored, 'segments'>, doc: Text): Authored =>
  value.runs.length === 0
    ? { ...value, segments: [] }
    : { ...value, segments: markSegments(value.runs, (pos) => doc.lineAt(pos).number) }

function read(ydoc: Y.Doc, noteId: string): Omit<Authored, 'segments'> {
  if (ydoc.getMap(WRITES).size === 0) return NONE
  return {
    runs: attribute(ydoc, noteId),
    writes: new Map(
      writesWithWriters(ydoc, noteId).map(({ write, writer }) => [
        write.id,
        { writer, at: write.at },
      ]),
    ),
  }
}

/** The marks of the document's runs: set again after each change to the Yjs document, mapped through the editor's changes until then. */
export function authoredField(ydoc: Y.Doc, noteId: string) {
  return StateField.define<Authored>({
    create: (state) => withSegments(read(ydoc, noteId), state.doc),
    update(value, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setAuthored)) return withSegments(effect.value, tr.state.doc)
      }
      if (!tr.docChanged || value.runs.length === 0) return value
      const runs = value.runs.flatMap((run) => {
        const from = tr.changes.mapPos(run.from, 1)
        const to = tr.changes.mapPos(run.to, -1)
        return to > from ? [{ ...run, from, to }] : []
      })
      return withSegments({ runs, writes: value.writes }, tr.state.doc)
    },
  })
}

interface Placed {
  index: number
  top: number
  height: number
}

const theme = EditorView.theme({
  '.cm-authorship': { position: 'absolute', top: '0', left: '0', zIndex: '200' },
  '.cm-authorship-mark': {
    position: 'absolute',
    // The content's own padding and the line's before the text (BOX_HANG and CodeMirror's 6px).
    width: 'var(--space-5)',
    padding: '0',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    outline: 'none',
  },
  '.cm-authorship-mark::before': {
    content: '""',
    position: 'absolute',
    top: 'var(--space-1)',
    bottom: 'var(--space-1)',
    left: 'var(--space-1)',
    width: 'var(--space-1)',
    borderRadius: 'var(--space-1)',
    background: 'var(--color-editor-authorship)',
  },
  '.cm-authorship-mark:focus-visible': {
    boxShadow: 'inset 0 0 0 var(--size-focus-ring) var(--color-focus-ring)',
    borderRadius: 'var(--radius-control)',
  },
  '.cm-authorship-tip': {
    position: 'absolute',
    whiteSpace: 'nowrap',
    padding: 'var(--space-1) var(--space-3)',
    borderRadius: 'var(--radius-popover)',
    background: 'var(--color-surface-popover)',
    color: 'var(--color-text-primary)',
    boxShadow:
      '0 var(--shadow-popover-y) var(--shadow-popover-key-blur) var(--color-shadow-popover-key), 0 var(--shadow-popover-y) var(--shadow-popover-ambient-blur) var(--color-shadow-popover-ambient)',
    fontFamily: 'var(--font-family-ui)',
    fontSize: 'var(--font-size-caption)',
    pointerEvents: 'none',
  },
})

/** The marks of `ydoc`, the replica the editor shows. */
export function authorshipMarks(ydoc: Y.Doc, noteId: string): Extension {
  const field = authoredField(ydoc, noteId)
  const plugin = ViewPlugin.fromClass(
    class {
      readonly dom = document.createElement('div')
      readonly tip = document.createElement('div')
      marks: HTMLButtonElement[] = []
      /** The segment that is the marks' tab stop. */
      current = 0
      focusNext: number | undefined
      tipFor: HTMLButtonElement | undefined
      pending = false
      destroyed = false

      constructor(readonly view: EditorView) {
        this.dom.className = 'cm-authorship'
        this.dom.setAttribute('role', 'group')
        this.dom.setAttribute('aria-label', t('authorship.marks'))
        this.tip.className = 'cm-authorship-tip'
        this.tip.setAttribute('aria-hidden', 'true')
        this.tip.hidden = true
        this.dom.appendChild(this.tip)
        view.scrollDOM.appendChild(this.dom)
        ydoc.on('update', this.changed)
        this.draw()
      }

      // After the transaction that changed the document, once: the editor's own changes reach
      // Yjs inside its update, where no new one may start.
      readonly changed = () => {
        if (this.pending) return
        this.pending = true
        queueMicrotask(() => {
          this.pending = false
          // The editor takes a remote change in as Yjs applies it; until then the runs do not fit.
          if (this.destroyed || ydoc.getText('body').length !== this.view.state.doc.length) return
          this.view.dispatch({ effects: setAuthored.of(read(ydoc, noteId)) })
        })
      }

      update(update: ViewUpdate) {
        if (
          update.state.field(field) !== update.startState.field(field) ||
          update.viewportChanged ||
          update.geometryChanged
        ) {
          this.draw()
        }
      }

      draw() {
        this.view.requestMeasure({
          key: this,
          read: (view) => this.measure(view),
          write: (placed, view) => this.place(placed, view),
        })
      }

      measure(view: EditorView): { left: number; placed: Placed[] } {
        const { segments } = view.state.field(field)
        if (segments.length === 0) return { left: 0, placed: [] }
        const { doc } = view.state
        const scroller = view.scrollDOM.getBoundingClientRect()
        const content = view.contentDOM.getBoundingClientRect()
        const top = view.documentTop - scroller.top + view.scrollDOM.scrollTop
        const left = content.left - scroller.left + view.scrollDOM.scrollLeft
        const first = doc.lineAt(view.viewport.from).number
        const last = doc.lineAt(view.viewport.to).number
        const placed = segments.flatMap((segment, index) => {
          if (segment.toLine < first || segment.fromLine > last) return []
          const start = view.lineBlockAt(doc.line(segment.fromLine).from)
          const end = view.lineBlockAt(doc.line(segment.toLine).from)
          return [{ index, top: top + start.top, height: end.bottom - start.top }]
        })
        return { left, placed }
      }

      place({ left, placed }: { left: number; placed: Placed[] }, view: EditorView) {
        const { segments, writes } = view.state.field(field)
        const locale = currentLocale()
        if (this.current >= segments.length) this.current = 0
        const stop = placed.some((p) => p.index === this.current)
          ? this.current
          : (placed[0]?.index ?? -1)
        placed.forEach((p, i) => {
          const mark = this.marks[i] ?? this.makeMark()
          this.marks[i] = mark
          mark.dataset['segment'] = String(p.index)
          mark.style.left = `${left}px`
          mark.style.top = `${p.top}px`
          mark.style.height = `${p.height}px`
          mark.tabIndex = p.index === stop ? 0 : -1
          mark.setAttribute('aria-label', markLabel(segments[p.index]!, writes, locale))
        })
        for (const extra of this.marks.splice(placed.length)) extra.remove()
        if (this.focusNext !== undefined) {
          const wanted = this.marks.find((m) => Number(m.dataset['segment']) === this.focusNext)
          if (wanted) {
            this.focusNext = undefined
            wanted.focus()
          }
        }
        // The mark under the pointer or with the keyboard may have moved, or gone.
        if (this.tipFor && this.marks.includes(this.tipFor)) this.showTip(this.tipFor)
        else this.hideTip()
      }

      makeMark(): HTMLButtonElement {
        const mark = document.createElement('button')
        mark.type = 'button'
        mark.className = 'cm-authorship-mark'
        const show = () => this.showTip(mark)
        const hide = () => this.hideTip()
        mark.addEventListener('mouseenter', show)
        mark.addEventListener('focus', () => {
          this.current = Number(mark.dataset['segment'])
          show()
        })
        mark.addEventListener('mouseleave', () => {
          if (mark !== this.focused()) hide()
        })
        mark.addEventListener('blur', hide)
        mark.addEventListener('click', () => this.select(Number(mark.dataset['segment'])))
        mark.addEventListener('keydown', (event) =>
          this.key(event, Number(mark.dataset['segment'])),
        )
        this.dom.appendChild(mark)
        return mark
      }

      /** In the editor's shadow root, the document's own active element is the host. */
      focused(): Element | null {
        return (this.dom.getRootNode() as Document | ShadowRoot).activeElement
      }

      showTip(mark: HTMLButtonElement) {
        this.tipFor = mark
        this.tip.textContent = mark.getAttribute('aria-label')
        this.tip.style.left = `calc(${mark.style.left} + var(--space-2))`
        this.tip.style.top = mark.style.top
        this.tip.hidden = false
      }

      hideTip() {
        this.tipFor = undefined
        this.tip.hidden = true
      }

      select(index: number) {
        const { segments, runs } = this.view.state.field(field)
        const segment = segments[index]
        const range = segment && segmentRange(segment, runs, this.view.state.doc)
        if (!range) return
        this.view.focus()
        this.view.dispatch({ selection: { anchor: range.from, head: range.to } })
      }

      key(event: KeyboardEvent, index: number) {
        const { segments } = this.view.state.field(field)
        const to =
          event.key === 'ArrowDown'
            ? index + 1
            : event.key === 'ArrowUp'
              ? index - 1
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? segments.length - 1
                  : undefined
        if (event.key === 'Escape') {
          event.preventDefault()
          this.view.focus()
          return
        }
        if (to === undefined || to < 0 || to >= segments.length) return
        event.preventDefault()
        this.current = to
        this.focusNext = to
        const line = this.view.state.doc.line(segments[to]!.fromLine)
        this.view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
        this.draw()
      }

      destroy() {
        this.destroyed = true
        ydoc.off('update', this.changed)
        this.dom.remove()
      }
    },
  )
  return [field, plugin, theme]
}
