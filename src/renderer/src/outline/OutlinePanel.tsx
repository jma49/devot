import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import { Chevron } from '../Chevron'
import { t } from '../i18n'
import type { ScrollPane } from '../preview/scrollSync'
import { useText, type TextStore } from '../textStore'
import {
  currentHeading,
  outlineHeadings,
  shownAncestor,
  shownHeadings,
  type OutlineHeading,
} from './headings'

export interface LineStore {
  get(): number
  set(line: number): void
  subscribe(listener: () => void): () => void
}

export function lineStore(initial = 1): LineStore {
  let line = initial
  const listeners = new Set<() => void>()
  return {
    get: () => line,
    set(next) {
      if (next === line) return
      line = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

const depthOf = (headings: readonly OutlineHeading[], index: number) => {
  let depth = 0
  for (let i = headings[index]!.parent; i >= 0; i = headings[i]!.parent) depth++
  return depth
}

export interface OutlineTreeProps {
  headings: readonly OutlineHeading[]
  folded: ReadonlySet<string>
  /** The source line the reader is at: the caret's, or the top of the preview. */
  line: number
  onJump: (line: number) => void
  onToggle: (key: string) => void
  onLeave: () => void
}

export function OutlineTree(props: OutlineTreeProps) {
  const { headings, folded, line } = props
  const shown = useMemo(() => shownHeadings(headings, folded), [headings, folded])
  const marked = shownAncestor(headings, shown, currentHeading(headings, line))
  const [active, setActive] = useState<string | null>(null)
  const rows = useRef(new Map<string, HTMLElement>())
  const tabStop =
    shown.find((i) => headings[i]!.key === active) ?? (marked >= 0 ? marked : shown[0])

  if (headings.length === 0) return <p className="outline-empty">{t('outline.empty')}</p>

  const move = (to: number | undefined) => {
    const key = to === undefined ? undefined : headings[to]?.key
    if (key === undefined) return
    setActive(key)
    rows.current.get(key)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const heading = headings[index]!
    const at = shown.indexOf(index)
    const handled = (run: () => void) => {
      event.preventDefault()
      event.stopPropagation()
      run()
    }
    switch (event.key) {
      case 'ArrowDown':
        return handled(() => move(shown[at + 1]))
      case 'ArrowUp':
        return handled(() => move(shown[at - 1]))
      case 'Home':
        return handled(() => move(shown[0]))
      case 'End':
        return handled(() => move(shown[shown.length - 1]))
      case 'ArrowRight':
        return handled(() => {
          if (heading.hasChildren && folded.has(heading.key)) props.onToggle(heading.key)
        })
      case 'ArrowLeft':
        return handled(() => {
          if (heading.hasChildren && !folded.has(heading.key)) props.onToggle(heading.key)
          else move(heading.parent >= 0 ? heading.parent : undefined)
        })
      case 'Enter':
        return handled(() => props.onJump(heading.line))
      case 'Escape':
        return handled(props.onLeave)
    }
  }

  return (
    <ul className="outline-tree" role="tree" aria-label={t('outline.label')}>
      {shown.map((index) => {
        const heading = headings[index]!
        const isFolded = heading.hasChildren && folded.has(heading.key)
        return (
          <li key={heading.key} role="none">
            <div
              ref={(el) => {
                if (el) rows.current.set(heading.key, el)
                else rows.current.delete(heading.key)
              }}
              className="outline-row"
              role="treeitem"
              aria-level={depthOf(headings, index) + 1}
              aria-expanded={heading.hasChildren ? !isFolded : undefined}
              aria-current={index === marked ? 'location' : undefined}
              tabIndex={index === tabStop ? 0 : -1}
              data-current={index === marked ? '' : undefined}
              style={{ '--outline-depth': depthOf(headings, index) } as React.CSSProperties}
              onClick={() => {
                setActive(heading.key)
                props.onJump(heading.line)
              }}
              onFocus={() => setActive(heading.key)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {heading.hasChildren ? (
                <span
                  className="outline-fold"
                  aria-hidden="true"
                  onClick={(event) => {
                    event.stopPropagation()
                    props.onToggle(heading.key)
                  }}
                >
                  <Chevron open={!isFolded} closed="right" />
                </span>
              ) : (
                <span className="outline-fold" aria-hidden="true" />
              )}
              <span className="outline-label">{heading.label}</span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function useReadingLine(
  mode: 'edit' | 'split' | 'preview',
  caret: LineStore,
  preview: ScrollPane | null,
) {
  const caretLine = useSyncExternalStore(caret.subscribe, caret.get)
  const [top, setTop] = useState(1)
  useEffect(() => {
    if (mode !== 'preview' || !preview) return
    let frame = 0
    const read = () => {
      frame = 0
      setTop(Math.floor(preview.topLine() + 0.5))
    }
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(read)
    }
    read()
    preview.element.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      preview.element.removeEventListener('scroll', onScroll)
    }
  }, [mode, preview])
  return mode === 'preview' ? top : caretLine
}

export interface OutlinePanelProps {
  text: TextStore
  caret: LineStore
  mode: 'edit' | 'split' | 'preview'
  previewPane: ScrollPane | null
  folded: ReadonlySet<string>
  onToggle: (key: string) => void
  onJump: (line: number) => void
  onLeave: () => void
}

export function OutlinePanel(props: OutlinePanelProps) {
  const text = useDeferredValue(useText(props.text))
  const headings = useMemo(() => outlineHeadings(text), [text])
  const line = useReadingLine(props.mode, props.caret, props.previewPane)
  return (
    <nav className="outline" aria-label={t('outline.label')}>
      <OutlineTree
        headings={headings}
        folded={props.folded}
        line={line}
        onJump={props.onJump}
        onToggle={props.onToggle}
        onLeave={props.onLeave}
      />
    </nav>
  )
}
