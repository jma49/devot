import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import type { GraphView } from '../../../core/graph'
import { errorCode } from '../../../core/errors'
import type { Core } from '../core-client'
import { countOf, formatNumber } from '../format'
import { currentLocale, format, t } from '../i18n'
import { useSegmentSlide } from '../segmentSlide'
import {
  dotRadius,
  FEW_NOTES,
  fitCamera,
  LABEL_ZOOM,
  neighbourhood,
  noteAt,
  toScreen,
  zoomAt,
  type Camera,
} from './view'

const SHOW_GRAPH = 'devot:show-graph'

/** View > Show Graph, from the palette. */
export function requestGraph(): void {
  window.dispatchEvent(new CustomEvent(SHOW_GRAPH))
}

export function useGraphCommand(open: () => void): void {
  const latest = useRef(open)
  useLayoutEffect(() => {
    latest.current = open
  })
  useEffect(() => {
    const show = () => latest.current()
    window.addEventListener(SHOW_GRAPH, show)
    return () => window.removeEventListener(SHOW_GRAPH, show)
  }, [])
}

type Scope = 'note' | 'all'

/** One request at a time: an answer counts only for the scope it was asked for. */
type Load =
  | { kind: 'loading'; scope: Scope; ask: number }
  | { kind: 'ready'; scope: Scope; view: GraphView }
  | { kind: 'failed'; scope: Scope }

// Pixels a press may move and still be a click on a note.
const CLICK_SLOP = 4
const ZOOM_STEP = 1.25
const PAN_STEP = 60

interface Colours {
  link: string
  note: string
  near: string
  focus: string
  label: string
  font: string
}

function colours(el: HTMLElement): Colours {
  const css = getComputedStyle(el)
  const token = (name: string) => css.getPropertyValue(name).trim()
  return {
    link: token('--color-line-control'),
    note: token('--color-text-tertiary'),
    near: token('--color-text-secondary'),
    focus: token('--color-accent-fill'),
    label: token('--color-text-secondary'),
    font: `${token('--font-size-caption')} ${css.fontFamily}`,
  }
}

function draw(
  canvas: HTMLCanvasElement,
  view: GraphView,
  camera: Camera,
  hovered: number,
  focus: string | undefined,
  untitled: string,
) {
  const ratio = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio)
  if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio)
  const g = canvas.getContext('2d')
  if (!g) return
  const ink = colours(canvas)
  g.setTransform(ratio, 0, 0, ratio, 0, 0)
  g.clearRect(0, 0, width, height)
  const { notes, links } = view
  const near = hovered >= 0 ? neighbourhood(links, hovered) : undefined
  const most = notes.reduce((m, n) => Math.max(m, n.links), 0)
  const screen = notes.map((note) => toScreen(camera, note))

  g.lineWidth = 1
  g.strokeStyle = ink.link
  g.beginPath()
  for (const [a, b] of links) {
    if (near && near.has(a) && near.has(b) && (a === hovered || b === hovered)) continue
    g.moveTo(screen[a]!.x, screen[a]!.y)
    g.lineTo(screen[b]!.x, screen[b]!.y)
  }
  g.globalAlpha = near ? 0.4 : 1
  g.stroke()
  g.globalAlpha = 1
  if (near) {
    g.strokeStyle = ink.focus
    g.beginPath()
    for (const [a, b] of links) {
      if (a !== hovered && b !== hovered) continue
      g.moveTo(screen[a]!.x, screen[a]!.y)
      g.lineTo(screen[b]!.x, screen[b]!.y)
    }
    g.stroke()
  }

  for (const [i, note] of notes.entries()) {
    const at = screen[i]!
    if (at.x < -20 || at.y < -20 || at.x > width + 20 || at.y > height + 20) continue
    g.fillStyle =
      note.id === focus || i === hovered ? ink.focus : near?.has(i) ? ink.near : ink.note
    g.globalAlpha = near && !near.has(i) ? 0.4 : 1
    g.beginPath()
    g.arc(
      at.x,
      at.y,
      dotRadius(note, most) * Math.min(1, Math.max(0.6, camera.zoom)),
      0,
      Math.PI * 2,
    )
    g.fill()
  }
  g.globalAlpha = 1

  const everyLabel = camera.zoom >= LABEL_ZOOM || notes.length <= FEW_NOTES
  g.font = ink.font
  g.fillStyle = ink.label
  g.textAlign = 'center'
  g.textBaseline = 'top'
  for (const [i, note] of notes.entries()) {
    const shown = everyLabel || i === hovered || note.id === focus || near?.has(i)
    if (!shown) continue
    const at = screen[i]!
    if (at.x < -100 || at.y < -20 || at.x > width + 100 || at.y > height + 20) continue
    g.globalAlpha = near && !near.has(i) ? 0.4 : 1
    g.fillText(note.title || untitled, at.x, at.y + dotRadius(note, most) + 3)
  }
  g.globalAlpha = 1
}

/**
 * The graph sheet: the open note and the notes within two links of it, or every linked note, as
 * dots and lines laid out by the core. Dragging pans, scrolling or pinching zooms, and clicking a
 * note opens it; on the keyboard the arrows pan, + and - zoom and 0 fits the graph again, and a list
 * of the notes (hidden but for assistive tech) opens them too.
 */
export function GraphSheet(props: {
  core: Core
  focus: string | undefined
  onOpenNote: (id: string) => void
  onClose: () => void
}) {
  const { core, focus, onOpenNote, onClose } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const scopes = useRef<HTMLDivElement>(null)
  const [scope, setScope] = useState<Scope>(focus ? 'note' : 'all')
  const [load, setLoad] = useState<Load>({ kind: 'loading', scope, ask: 0 })
  const asks = useRef(0)
  const camera = useRef<Camera>({ zoom: 1, x: 0, y: 0 })
  const hovered = useRef(-1)
  const press = useRef<{ x: number; y: number; camera: Camera; moved: boolean } | null>(null)
  const frame = useRef(0)
  const locale = currentLocale()
  useSegmentSlide(scopes, scope === 'note' ? 0 : 1)

  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    return () => el?.close()
  }, [])

  useEffect(() => {
    const ask = ++asks.current
    setLoad({ kind: 'loading', scope, ask })
    core.linkGraph(scope === 'note' ? focus : undefined).then(
      (view) => {
        if (asks.current === ask) setLoad({ kind: 'ready', scope, view })
      },
      (e: unknown) => {
        console.warn('W_GRAPH_FAILED', errorCode(e))
        if (asks.current === ask) setLoad({ kind: 'failed', scope })
      },
    )
    return () => {
      asks.current += 1
    }
  }, [core, focus, scope])

  const view = load.kind === 'ready' ? load.view : undefined

  const redraw = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      if (canvas.current && view) {
        draw(canvas.current, view, camera.current, hovered.current, focus, t('note.untitled'))
      }
    })
  }, [view, focus])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const fit = useCallback(() => {
    const el = canvas.current
    if (!el || !view) return
    camera.current = fitCamera(view.notes, el.clientWidth, el.clientHeight, 32)
    redraw()
  }, [view, redraw])

  useLayoutEffect(() => {
    hovered.current = -1
    fit()
  }, [fit])

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const sizes = new ResizeObserver(redraw)
    sizes.observe(el)
    // Not passive, so the page itself does not zoom or scroll.
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = el.getBoundingClientRect()
      const px = event.clientX - box.left
      const py = event.clientY - box.top
      if (event.ctrlKey || event.metaKey) {
        camera.current = zoomAt(camera.current, Math.exp(-event.deltaY / 100), px, py)
      } else {
        const now = camera.current
        camera.current = { ...now, x: now.x - event.deltaX, y: now.y - event.deltaY }
      }
      redraw()
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      sizes.disconnect()
      el.removeEventListener('wheel', wheel)
    }
  }, [redraw])

  const pointAt = (event: { clientX: number; clientY: number }) => {
    const box = canvas.current!.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }

  const open = (id: string) => {
    onClose()
    onOpenNote(id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const el = canvas.current
    if (!el) return
    const now = camera.current
    const middle = [el.clientWidth / 2, el.clientHeight / 2] as const
    const moves: Record<string, () => Camera> = {
      ArrowLeft: () => ({ ...now, x: now.x + PAN_STEP }),
      ArrowRight: () => ({ ...now, x: now.x - PAN_STEP }),
      ArrowUp: () => ({ ...now, y: now.y + PAN_STEP }),
      ArrowDown: () => ({ ...now, y: now.y - PAN_STEP }),
      '+': () => zoomAt(now, ZOOM_STEP, ...middle),
      '=': () => zoomAt(now, ZOOM_STEP, ...middle),
      '-': () => zoomAt(now, 1 / ZOOM_STEP, ...middle),
    }
    if (event.key === '0') {
      event.preventDefault()
      fit()
      return
    }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    camera.current = move()
    redraw()
  }

  const notesText = view
    ? countOf(view.notes.length, locale, 'graph.notesOne', 'graph.notesOther')
    : ''
  const linksText = view
    ? countOf(view.links.length, locale, 'graph.linksOne', 'graph.linksOther')
    : ''
  const lonely = view && view.links.length === 0

  return (
    <dialog
      ref={dialog}
      className="sheet graph"
      aria-labelledby="graph-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClose={(e) => {
        if (e.target === e.currentTarget && !dialog.current?.open) onClose()
      }}
    >
      <div className="graph-head">
        <div>
          <h2 id="graph-title" className="sheet-title">
            {t('graph.title')}
          </h2>
          <p className="sheet-detail">{t('graph.detail')}</p>
        </div>
        {focus ? (
          <div ref={scopes} className="segmented" role="group" aria-label={t('graph.scope')}>
            <button
              type="button"
              className="segment graph-scope"
              aria-pressed={scope === 'note'}
              onClick={() => setScope('note')}
            >
              {t('graph.thisNote')}
            </button>
            <button
              type="button"
              className="segment graph-scope"
              aria-pressed={scope === 'all'}
              onClick={() => setScope('all')}
            >
              {t('graph.allNotes')}
            </button>
          </div>
        ) : null}
      </div>
      {load.kind === 'failed' ? (
        <p role="alert" className="sheet-error">
          {t('graph.failed')}
        </p>
      ) : null}
      <div className="graph-stage" data-loading={load.kind === 'loading' || undefined}>
        <canvas
          ref={canvas}
          className="graph-canvas"
          tabIndex={0}
          role="img"
          aria-label={view ? format(t('graph.label'), { notes: notesText, links: linksText }) : ''}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            canvas.current?.setPointerCapture(event.pointerId)
            const at = pointAt(event)
            press.current = { ...at, camera: camera.current, moved: false }
          }}
          onPointerMove={(event) => {
            const at = pointAt(event)
            const held = press.current
            if (held) {
              const dx = at.x - held.x
              const dy = at.y - held.y
              if (Math.hypot(dx, dy) > CLICK_SLOP) held.moved = true
              if (held.moved) {
                camera.current = { ...held.camera, x: held.camera.x + dx, y: held.camera.y + dy }
                redraw()
                return
              }
            }
            if (!view) return
            const under = noteAt(view.notes, camera.current, at.x, at.y)
            if (under === hovered.current) return
            hovered.current = under
            canvas.current!.dataset['pointing'] = under >= 0 ? 'note' : ''
            redraw()
          }}
          onPointerUp={(event) => {
            const held = press.current
            press.current = null
            if (!held || held.moved || !view) return
            const at = pointAt(event)
            const under = noteAt(view.notes, camera.current, at.x, at.y)
            if (under >= 0) open(view.notes[under]!.id)
          }}
          onPointerCancel={() => {
            press.current = null
          }}
          onPointerLeave={() => {
            if (press.current || hovered.current < 0) return
            hovered.current = -1
            redraw()
          }}
        />
        {lonely ? (
          <p className="graph-empty">{t(load.scope === 'note' ? 'graph.alone' : 'graph.empty')}</p>
        ) : null}
      </div>
      {view ? (
        <ul className="visually-hidden" aria-label={t('graph.notes')}>
          {view.notes.map((note) => (
            <li key={note.id}>
              <button type="button" tabIndex={-1} onClick={() => open(note.id)}>
                {note.title || t('note.untitled')}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="graph-foot">
        <p className="graph-count">
          {view ? [notesText, linksText].join(t('noteInfo.summarySeparator')) : null}
          {view?.capped ? (
            <span className="graph-capped">
              {format(t('graph.capped'), { count: formatNumber(view.notes.length, locale) })}
            </span>
          ) : null}
        </p>
        <button type="button" className="button" onClick={onClose}>
          {t('graph.done')}
        </button>
      </div>
    </dialog>
  )
}
