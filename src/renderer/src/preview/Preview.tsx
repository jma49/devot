import { invoke } from '../ipc'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { NoteLinkTarget, PreviewLabels } from '../../../core'
import { noteLinks } from '../../../core/links'
import { taskProgress } from '../../../core/tasks'
import { fragmentId } from '../../../core/preview/headingIds'
import { attachmentId, parseImageMarkdown } from '../../../core/images'
import { useContextMenu, type MenuPoint } from '../contextMenu'
import { copyText } from '../noteMenu'
import { onPluginRenderersChanged } from '../plugins/rendererRevision'
import { lookUp, startSpeaking, stopSpeaking } from '../textServices'
import {
  PREVIEW_MENU,
  previewLookUpTarget,
  previewMenuTarget,
  selectAllIn,
  type PreviewAction,
  type PreviewMenuTarget,
} from './previewMenu'
import { imageMenuHasItems, type ImageMenuTarget } from '../imageMenu'
import type { ViewedImage } from '../ImageViewer'
import type { Core } from '../core-client'
import { previewsFor } from '../notePreview'
import { NoteHover } from './NoteHover'
import { useText, type TextStore } from '../textStore'
import type { FindTarget } from '../find/target'
import { t } from '../i18n'
import { useAppearance } from '../icons/Icon'
import { patchPieces, type ShownPiece } from './dom'
import { previewFindTarget } from './find'
import { createIslandMounter, createIslandRegistry } from './islands'
import { CodeCopyButtons, codeBlocks } from './CodeCopy'
import { latestOnly } from './latest'
import { mermaidIsland } from './mermaid'
import { NoteInfo } from './NoteInfo'
import type { NoteInfoData } from './infoCard'
import type { SetNoteDates } from './NoteInfo'
import { previewScrollPane, type PreviewScrollPane, type ScrollPane } from './scrollSync'

const NOTE_LINK = /^devot:\/\/note\/([0-9a-f-]{36})$/

export const islands = createIslandRegistry([mermaidIsland])

export function previewLabels(): PreviewLabels {
  return {
    alerts: {
      note: t('alert.note'),
      tip: t('alert.tip'),
      important: t('alert.important'),
      warning: t('alert.warning'),
      caution: t('alert.caution'),
    },
    embedFrom: t('embed.from'),
    embedLoad: t('embed.load'),
    videoTitle: t('embed.videoTitle'),
    untitled: t('note.untitled'),
    missingNote: t('preview.missingNote'),
    codeLines: t('preview.codeLines'),
    codeLine: t('preview.codeLine'),
    codeRef: t('preview.codeRef'),
    codeSource: t('preview.codeSource'),
  }
}

interface RenderInput {
  markdown: string
  loadedEmbeds: string[]
}

interface Props {
  core: Core
  markdown: string
  info?: NoteInfoData | undefined
  onSetDates?: SetNoteDates | undefined
  onOpenNote: (id: string) => void
  onFind?: (target: FindTarget | null) => void
  onScrollPane?: (pane: ScrollPane | null) => void
  onOpenImage?: (image: ViewedImage) => void
  onImageMenu?: (image: ImageMenuTarget, at: MenuPoint) => void
  /**
   * Where to scroll to once the note has rendered (a restored window); asked
   * once, at the first render with content.
   */
  initialScroll?: () => number | undefined
  onScroll?: (top: number) => void
  onToggleTask?: (at: number) => void
}

/**
 * What the image menu needs about a preview image: the attachment it shows,
 * its size, and where it is in `markdown`, the text the preview was rendered
 * from (the renderer marks each inline image). The editor checks that the
 * text is still there before changing it.
 */
export function previewImageTarget(img: HTMLImageElement, markdown: string): ImageMenuTarget {
  const from = Number(img.dataset['imageFrom'])
  const to = Number(img.dataset['imageTo'])
  const text =
    Number.isInteger(from) && Number.isInteger(to) && img.dataset['imageFrom'] !== undefined
      ? markdown.slice(from, to)
      : ''
  const parsed = text ? parseImageMarkdown(text) : null
  return {
    fileId: attachmentId(img.getAttribute('src') ?? ''),
    source: parsed?.sizable ? { from, to, text } : null,
    size: parsed?.size ?? 'auto',
  }
}

const lineCount = (text: string) => {
  let lines = 1
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lines += 1
  return lines
}

const sameList = (a: readonly HTMLElement[], b: readonly HTMLElement[]) =>
  a.length === b.length && a.every((el, i) => el === b[i])

/**
 * How long a restored scroll position is kept up while images and diagrams
 * load and the content grows to reach it.
 */
const RESTORE_SCROLL_MS = 5000

/**
 * The open note's preview, following the editor's text by itself (see
 * textStore.ts): typing renders it, and nothing around it.
 */
export function LivePreview({ text, ...props }: Omit<Props, 'markdown'> & { text: TextStore }) {
  return <Preview {...props} markdown={useText(text)} />
}

export function Preview({
  core,
  markdown,
  info,
  onSetDates,
  onOpenNote,
  onFind,
  onScrollPane,
  onOpenImage,
  onImageMenu,
  initialScroll,
  onScroll,
  onToggleTask,
}: Props) {
  const pane = useRef<HTMLElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const [loadedEmbeds, setLoadedEmbeds] = useState<string[]>([])
  const appearance = useAppearance()
  const appearanceNow = useRef(appearance)
  const scroll = useRef<PreviewScrollPane | null>(null)
  const [mounter] = useState(() =>
    createIslandMounter(islands, { scroller: (body) => body.parentElement }),
  )
  const [codes, setCodes] = useState<HTMLElement[]>([])

  const render = useRef<(input: RenderInput) => void>(undefined)
  const pieces = useRef<ShownPiece[]>([])
  /** The Markdown the preview on screen was rendered from (images point into it). */
  const shown = useRef('')
  const findHandle = useRef(onFind)
  const scrollHandle = useRef(onScrollPane)
  const scrollAsked = useRef(initialScroll)
  const scrolled = useRef(onScroll)
  const noteNow = useRef(info?.noteId)
  useEffect(() => {
    noteNow.current = info?.noteId
    findHandle.current = onFind
    scrollHandle.current = onScrollPane
    scrollAsked.current = initialScroll
    scrolled.current = onScroll
  })
  // A restored scroll position (see `initialScroll`): asked for at the first
  // render with content, then applied again as the content grows (images,
  // diagrams) until it is reached, the user scrolls, or time runs out.
  const scrollTarget = useRef<{ top: number; until: number; sizes: ResizeObserver }>(undefined)
  const scrollAskedOnce = useRef(false)
  const stopRestoring = useCallback(() => {
    scrollTarget.current?.sizes.disconnect()
    scrollTarget.current = undefined
  }, [])
  const keepRestoring = useCallback(() => {
    const target = scrollTarget.current
    const el = pane.current
    if (!target || !el) return
    if (performance.now() > target.until) return stopRestoring()
    el.scrollTop = target.top
    if (Math.abs(el.scrollTop - target.top) < 1) return stopRestoring()
    for (const child of Array.from(el.children)) target.sizes.observe(child)
  }, [stopRestoring])
  useEffect(() => () => scrollTarget.current?.sizes.disconnect(), [])

  useEffect(() => {
    if (!pane.current) return
    const target = previewFindTarget(pane.current)
    findHandle.current?.(target)
    const scrolling = previewScrollPane(pane.current)
    scroll.current = scrolling
    scrollHandle.current?.(scrolling)
    return () => {
      target.clear()
      findHandle.current?.(null)
      scrolling.dispose()
      scroll.current = null
      scrollHandle.current?.(null)
    }
  }, [])

  useEffect(() => {
    const islandRendered = () => scroll.current?.changed()
    // What the note links to, for its chips: asked again only when another
    // note opens or the set of linked notes changes.
    let known: { key: string; targets: Promise<Record<string, NoteLinkTarget>> } | undefined
    const targetsFor = (text: string) => {
      const ids = noteLinks(text)
      if (ids.length === 0) return Promise.resolve({})
      const key = `${noteNow.current ?? ''} ${ids.join(' ')}`
      if (known?.key !== key) {
        const targets = core.linkTargets(ids).catch(() => {
          console.warn('W_LINK_TARGETS_FAILED')
          known = undefined
          return undefined
        })
        known = { key, targets: targets.then((found) => found ?? {}) }
        return targets
      }
      return known.targets
    }
    const run = latestOnly(
      (input: RenderInput) =>
        targetsFor(input.markdown)
          .then((targets) =>
            core.renderPreviewPieces(
              input.markdown,
              {
                labels: previewLabels(),
                loadedEmbeds: input.loadedEmbeds,
                ...(targets ? { noteLinks: targets } : {}),
              },
              pieces.current.map((piece) => piece.key),
            ),
          )
          .then((next) => ({ next, input })),
      ({ next, input }) => {
        if (!host.current) return
        try {
          pieces.current = patchPieces(host.current, pieces.current, next)
        } catch {
          // The worker counted on a piece the page no longer has: start over.
          console.warn('W_PREVIEW_PIECES_RESET')
          host.current.replaceChildren()
          pieces.current = []
          run(input)
          return
        }
        shown.current = input.markdown
        mounter.mount(host.current, { appearance: appearanceNow.current }, islandRendered)
        const blocks = codeBlocks(host.current)
        setCodes((now) => (sameList(now, blocks) ? now : blocks))
        scroll.current?.changed(lineCount(input.markdown))
        if (!scrollAskedOnce.current && pieces.current.some((piece) => piece.nodes.length > 0)) {
          scrollAskedOnce.current = true
          const top = scrollAsked.current?.()
          if (top !== undefined) {
            const sizes = new ResizeObserver(keepRestoring)
            scrollTarget.current = { top, until: performance.now() + RESTORE_SCROLL_MS, sizes }
          }
        }
        keepRestoring()
      },
      () => console.warn('W_PREVIEW_RENDER_FAILED'),
    )
    render.current = run
  }, [core, mounter, keepRestoring])

  useEffect(() => {
    appearanceNow.current = appearance
    if (host.current) mounter.mount(host.current, { appearance }, () => scroll.current?.changed())
  }, [appearance, mounter])

  // Leaving the preview frees what its diagrams hold (their stylesheets).
  useEffect(() => () => mounter.dispose(), [mounter])

  useEffect(() => render.current?.({ markdown, loadedEmbeds }), [markdown, loadedEmbeds])
  const input = useRef({ markdown, loadedEmbeds })
  useEffect(() => {
    input.current = { markdown, loadedEmbeds }
  })
  useEffect(() => onPluginRenderersChanged(() => render.current?.(input.current)), [])

  const tasks = useMemo(() => taskProgress(markdown), [markdown])

  const onClick = (event: MouseEvent) => {
    const target = event.target as Element
    const box = target.closest('input[data-task-at]')
    if (box) {
      // The box shows what the note says: the change comes back as a render.
      event.preventDefault()
      onToggleTask?.(Number(box.getAttribute('data-task-at')))
      return
    }
    const load = target.closest('[data-embed-load]')
    if (load) {
      const src = load.closest('[data-embed-src]')?.getAttribute('data-embed-src')
      if (src) setLoadedEmbeds((list) => (list.includes(src) ? list : [...list, src]))
      return
    }
    const link = target.closest('a')
    if (!link) return
    // Links never navigate the app's own page.
    event.preventDefault()
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('#')) {
      const id = fragmentId(decodeURIComponent(href.slice(1)))
      pane.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' })
      return
    }
    const note = NOTE_LINK.exec(href)
    if (note?.[1]) onOpenNote(note[1])
    else if (/^https:\/\//i.test(href)) {
      invoke('open_external', { url: href }).catch(() => console.warn('W_OPEN_EXTERNAL_FAILED'))
    }
  }

  const imageUnder = (event: MouseEvent) => {
    const target = event.target
    return target instanceof HTMLImageElement && host.current?.contains(target) ? target : null
  }
  const onDoubleClick = (event: MouseEvent) => {
    const img = imageUnder(event)
    if (!img || !onOpenImage) return
    event.preventDefault()
    onOpenImage({ src: img.currentSrc || img.src, alt: img.alt })
  }
  const menuAt = useRef<MenuPoint>({ x: 0, y: 0 })
  const pickMenuAction = useCallback((action: PreviewAction, target: PreviewMenuTarget) => {
    switch (action) {
      case 'copyLink': {
        const link = target.link
        if (link !== null) void copyText(link).catch(() => console.warn('W_LINK_COPY_FAILED'))
        return
      }
      case 'lookUp': {
        if (target.selection === null) return
        const selection = window.getSelection()
        const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
        const look = range ? previewLookUpTarget(range) : null
        void lookUp(target.selection, look?.at ?? menuAt.current, look?.font)
        return
      }
      case 'selectAll':
        if (pane.current) selectAllIn(pane.current, window.getSelection())
        return
      case 'startSpeaking':
        void startSpeaking(target.selection)
        return
      case 'stopSpeaking':
        void stopSpeaking()
        return
      // Copy is the system's own item; the submenu only holds items.
      default:
    }
  }, [])
  const showMenu = useContextMenu('preview', PREVIEW_MENU, pickMenuAction)
  const onContextMenu = (event: MouseEvent) => {
    const at = { x: event.clientX, y: event.clientY }
    const img = imageUnder(event)
    if (img) {
      if (!onImageMenu) return
      const image = previewImageTarget(img, shown.current)
      // An image the menu has nothing for keeps the web view's own menu.
      if (!imageMenuHasItems(image)) return
      event.preventDefault()
      onImageMenu(image, at)
      return
    }
    const target = event.target as Element
    // The info card's date fields keep the web view's own menu.
    if (target.closest('input, textarea, select, [contenteditable]')) return
    event.preventDefault()
    menuAt.current = at
    const selection = window.getSelection()
    const inPreview = !!selection?.anchorNode && !!pane.current?.contains(selection.anchorNode)
    const picked = previewMenuTarget(
      target.closest('a[href]'),
      inPreview ? selection.toString() : null,
    )
    void showMenu(picked, at)
  }

  return (
    <>
      <article
        ref={pane}
        className="preview"
        data-devot-part="preview"
        aria-label={t('preview.label')}
        // Focusable: a click puts find (Cmd+F) here in split mode, and the
        // keyboard scrolls it (Control+Tab lands here when it is the editor
        // area, see areas.ts).
        tabIndex={0}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        // Scrolling by the user ends a restore; scrolls made by it are not reported.
        onWheel={stopRestoring}
        onPointerDown={stopRestoring}
        onKeyDown={stopRestoring}
        onScroll={(event) => {
          if (!scrollTarget.current) scrolled.current?.(event.currentTarget.scrollTop)
        }}
      >
        {info ? (
          <NoteInfo
            core={core}
            info={info}
            tasks={tasks}
            onOpenNote={onOpenNote}
            onSetDates={onSetDates}
          />
        ) : null}
        <div ref={host} className="preview-body" />
      </article>
      <CodeCopyButtons blocks={codes} />
      <NoteHover pane={pane} load={previewsFor(core)} />
    </>
  )
}
