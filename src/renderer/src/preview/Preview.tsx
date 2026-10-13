import { invoke } from '../ipc'
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import type { PreviewLabels, RemoteImageLabels } from '../../../core'
import { attachmentId, parseImageMarkdown } from '../../../core/images'
import type { MenuPoint } from '../contextMenu'
import { imageMenuHasItems, type ImageMenuTarget } from '../imageMenu'
import type { ViewedImage } from '../ImageViewer'
import type { Core } from '../core-client'
import { useText, type TextStore } from '../textStore'
import type { FindTarget } from '../find/target'
import { t } from '../i18n'
import { useAppearance } from '../icons/Icon'
import { patchChildren } from './dom'
import { previewFindTarget } from './find'
import { createIslandMounter, createIslandRegistry } from './islands'
import { CodeCopyButtons, codeBlocks } from './CodeCopy'
import { latestOnly } from './latest'
import { mermaidIsland } from './mermaid'
import { previewScrollPane, type PreviewScrollPane, type ScrollPane } from './scrollSync'

const NOTE_LINK = /^devot:\/\/note\/([0-9a-f-]{36})$/

/** Built-in islands, registered through the same API as any other. */
export const islands = createIslandRegistry([mermaidIsland])

/** The preview's labels, in the UI's language. */
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
  }
}

/** The placeholder's texts for images from the web (the preview never loads them). */
function remoteImageLabels(): RemoteImageLabels {
  return { notLoaded: t('image.remoteNotLoaded'), why: t('image.remoteWhy') }
}

interface RenderInput {
  markdown: string
  loadedEmbeds: string[]
}

interface Props {
  core: Core
  markdown: string
  onOpenNote: (id: string) => void
  /** Gets the preview's find handle while it is shown, and null when it goes. */
  onFind?: (target: FindTarget | null) => void
  /** Gets the preview as a scroll pane while it is shown, and null when it goes. */
  onScrollPane?: (pane: ScrollPane | null) => void
  /** Double-click on an image: show it in the viewer. */
  onOpenImage?: (image: ViewedImage) => void
  /** Right-click on an image: the image menu, at a point in the window. */
  onImageMenu?: (image: ImageMenuTarget, at: MenuPoint) => void
  /**
   * Where to scroll to once the note has rendered (a restored window); asked
   * once, at the first render with content.
   */
  initialScroll?: () => number | undefined
  /** The user scrolled the preview; its scroll position. */
  onScroll?: (top: number) => void
  /** A task's box was clicked; where its mark is in the Markdown. */
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

/** The rendered note. Rendering runs in the core worker; this patches the DOM. */
export function Preview({
  core,
  markdown,
  onOpenNote,
  onFind,
  onScrollPane,
  onOpenImage,
  onImageMenu,
  initialScroll,
  onScroll,
  onToggleTask,
}: Props) {
  const host = useRef<HTMLElement>(null)
  const [loadedEmbeds, setLoadedEmbeds] = useState<string[]>([])
  const appearance = useAppearance()
  const appearanceNow = useRef(appearance)
  /** The preview as a scroll pane (see scrollSync.ts). */
  const scroll = useRef<PreviewScrollPane | null>(null)
  const [mounter] = useState(() => createIslandMounter(islands))
  const [codes, setCodes] = useState<HTMLElement[]>([])

  const render = useRef<(input: RenderInput) => void>(undefined)
  /** The Markdown the preview on screen was rendered from (images point into it). */
  const shown = useRef('')
  const findHandle = useRef(onFind)
  const scrollHandle = useRef(onScrollPane)
  const scrollAsked = useRef(initialScroll)
  const scrolled = useRef(onScroll)
  useEffect(() => {
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
    const el = host.current
    if (!target || !el) return
    if (performance.now() > target.until) return stopRestoring()
    el.scrollTop = target.top
    if (Math.abs(el.scrollTop - target.top) < 1) return stopRestoring()
    for (const child of Array.from(el.children)) target.sizes.observe(child)
  }, [stopRestoring])
  useEffect(() => () => scrollTarget.current?.sizes.disconnect(), [])

  useEffect(() => {
    if (!host.current) return
    const target = previewFindTarget(host.current)
    findHandle.current?.(target)
    const pane = previewScrollPane(host.current)
    scroll.current = pane
    scrollHandle.current?.(pane)
    return () => {
      target.clear()
      findHandle.current?.(null)
      pane.dispose()
      scroll.current = null
      scrollHandle.current?.(null)
    }
  }, [])

  useEffect(() => {
    // A diagram drawn after the rendering moves the blocks below it.
    const islandRendered = () => scroll.current?.changed()
    render.current = latestOnly(
      (input: RenderInput) =>
        core
          .renderPreview(input.markdown, {
            labels: previewLabels(),
            remoteImages: remoteImageLabels(),
            loadedEmbeds: input.loadedEmbeds,
          })
          .then((tree) => ({ tree, lines: lineCount(input.markdown), markdown: input.markdown })),
      ({ tree, lines, markdown: from }) => {
        if (!host.current) return
        patchChildren(host.current, tree.children)
        shown.current = from
        mounter.mount(host.current, { appearance: appearanceNow.current }, islandRendered)
        const next = codeBlocks(host.current)
        setCodes((now) => (sameList(now, next) ? now : next))
        scroll.current?.changed(lines)
        if (tree.children.length > 0 && !scrollAskedOnce.current) {
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
  }, [core, mounter, keepRestoring])

  // Diagrams follow light and dark.
  useEffect(() => {
    appearanceNow.current = appearance
    if (host.current) mounter.mount(host.current, { appearance }, () => scroll.current?.changed())
  }, [appearance, mounter])

  // Leaving the preview frees what its diagrams hold (their stylesheets).
  useEffect(() => () => mounter.dispose(), [mounter])

  useEffect(() => render.current?.({ markdown, loadedEmbeds }), [markdown, loadedEmbeds])

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
      const id = decodeURIComponent(href.slice(1))
      host.current
        ?.querySelector(`[id="${CSS.escape(id)}"], [id="${CSS.escape(`user-content-${id}`)}"]`)
        ?.scrollIntoView({ block: 'start' })
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
  const onContextMenu = (event: MouseEvent) => {
    const img = imageUnder(event)
    if (!img || !onImageMenu) return
    const image = previewImageTarget(img, shown.current)
    // An image the menu has nothing for keeps the web view's own menu.
    if (!imageMenuHasItems(image)) return
    event.preventDefault()
    onImageMenu(image, { x: event.clientX, y: event.clientY })
  }

  return (
    <>
      <article
        ref={host}
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
      />
      <CodeCopyButtons blocks={codes} />
    </>
  )
}
