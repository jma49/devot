import { invoke } from '../ipc'
import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react'
import type { RemoteImageWait } from '../../../core'
import { previewLabels } from './labels'
import { PreviewFrameContent } from './PreviewFrame'
import { loadedAny, NOTES_LOADED } from '../externalChanges'
import { fragmentId } from '../../../core/preview/headingIds'
import { attachmentId, parseImageMarkdown } from '../../../core/images'
import { useContextMenu, type MenuPoint } from '../contextMenu'
import { copyText } from '../noteMenu'
import { copySelection } from './copySelection'
import { keyMatches } from '../commands/keys'
import { onPluginRenderersChanged } from '../plugins/rendererRevision'
import { keptDrawingsOf, keptLanguages, loadKeptDrawings, watchKeptDrawings } from './keptDrawings'
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
import { isMissingImage, watchMissingImages } from '../missingImages'
import { previewsFor } from '../notePreview'
import { useEditorSetting } from '../editorSettings'
import { loadImagesFrom, useLoadedImageHosts } from '../remoteImages'
import { NoteHover } from './NoteHover'
import type { TextStore } from '../textStore'
import type { FindTarget } from '../find/target'
import { format, t } from '../i18n'
import { useAppearance } from '../icons/Icon'
import { shownTheme, subscribeAppearance } from '../theme/appearance'
import {
  buildFirstPieces,
  buildPending,
  buildToLine,
  FIRST_CHARACTERS,
  hasPending,
  noteOffset,
  patchPieces,
  type ShownPiece,
} from './dom'
import { EDIT_ATTRIBUTE, editPluginBlock } from './pluginEdits'
import { previewFindTarget } from './find'
import { createIslandMounter } from './islands'
import { islands } from './islandRegistry'
import { CodeCopyButtons, pieceCodeBlocks } from './CodeCopy'
import { afterPaint } from './afterPaint'
import { createOpening } from './opening'
import { latestOnly } from './latest'
import { warmMermaid } from './mermaid'
import {
  previewScrollPane,
  shiftScroll,
  type PreviewScrollPane,
  type ScrollPane,
} from './scrollSync'

const NOTE_LINK = /^devot:\/\/note\/([0-9a-f-]{36})$/

interface RenderInput {
  head?: boolean
  /** Read when the render starts, so renders that a newer one replaces never read the text. */
  read: () => string
  loadedEmbeds: string[]
  remoteImages: RemoteImageWait | undefined
  frontMatterInInfo: boolean
}

/** The text a preview shows, read only when a render starts (see textStore.ts). */
type PreviewText = Pick<TextStore, 'get' | 'subscribe'>

const fixedText = (markdown: string): PreviewText => ({
  get: () => markdown,
  subscribe: () => () => undefined,
})

type Props = PreviewProps &
  ({ markdown: string; text?: never } | { text: PreviewText; markdown?: never })

interface PreviewProps {
  core: Core
  /** The note shown, so its linked notes are asked for again when another one opens. */
  noteId?: string | undefined
  /** The main window's live preview: Note Info shows the front matter, so the body leaves it out. */
  frontMatterInInfo?: boolean
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
  onToggleTask?: ((at: number) => void) | undefined
  /** Plugin drawings show an Edit button that changes the note (ADR 0029). */
  blocksEditable?: boolean
}

/**
 * What the image menu needs about a preview image: the attachment it shows,
 * its size, and where it is in `markdown`, the text the preview was rendered
 * from (the renderer marks each inline image). The editor checks that the
 * text is still there before changing it.
 */
function previewImageTarget(
  img: HTMLImageElement,
  markdown: string,
  pieces: readonly ShownPiece[],
): ImageMenuTarget {
  const from = noteOffset(pieces, img, 'data-image-from') ?? Number.NaN
  const to = noteOffset(pieces, img, 'data-image-to') ?? Number.NaN
  const text = Number.isInteger(from) && Number.isInteger(to) ? markdown.slice(from, to) : ''
  const parsed = text ? parseImageMarkdown(text) : null
  return {
    fileId: attachmentId(img.getAttribute('src') ?? ''),
    source: parsed?.sizable ? { from, to, text } : null,
    size: parsed?.size ?? 'auto',
  }
}

const sameList = (a: readonly HTMLElement[], b: readonly HTMLElement[]) =>
  a.length === b.length && a.every((el, i) => el === b[i])

/**
 * How long a restored scroll position is kept up while images and diagrams
 * load and the content grows to reach it.
 */
/** Only a block in a fence can show a kept drawing (ADR 0030). */
const hasFence = (markdown: string) => markdown.includes('```') || markdown.includes('~~~')

const RESTORE_SCROLL_MS = 5000
const HEAD_CHARACTERS = 8000
const LONG_NOTE_CHARACTERS = 32_000

/** How long a task builds the pieces a render left for later, between other work. */
const SLICE_MS = 8
/** How often a long build adds diagrams and copy buttons to what it built (each pass reads the whole preview). */
const MOUNT_EVERY_MS = 250

/**
 * The open note's preview, following the editor's text by itself (see
 * textStore.ts): typing renders the note into it, and renders no component.
 */
export function LivePreview(props: PreviewProps & { text: TextStore }) {
  return <Preview {...props} />
}

export function Preview({
  core,
  markdown,
  text: followed,
  noteId,
  frontMatterInInfo = false,
  onOpenNote,
  onFind,
  onScrollPane,
  onOpenImage,
  onImageMenu,
  initialScroll,
  onScroll,
  onToggleTask,
  blocksEditable = false,
}: Props) {
  const text = useMemo(() => followed ?? fixedText(markdown ?? ''), [followed, markdown])
  const pane = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    pane.current = host.current?.closest<HTMLElement>('.preview') ?? null
    return () => {
      pane.current = null
    }
  }, [])
  const host = useRef<HTMLDivElement>(null)
  const [loadedEmbeds, setLoadedEmbeds] = useState<string[]>([])
  const loadRemoteImages = useEditorSetting('loadRemoteImages')
  const loadedHosts = useLoadedImageHosts()
  const remoteImages = useMemo(
    () =>
      loadRemoteImages
        ? undefined
        : { loadedHosts, from: t('image.remoteFrom'), load: t('image.remoteLoad') },
    [loadRemoteImages, loadedHosts],
  )
  const [refusedLink, setRefusedLink] = useState<string>()
  const appearance = useAppearance()
  const theme = useSyncExternalStore(subscribeAppearance, shownTheme, () => '')
  const islandContext = useRef<{
    appearance: typeof appearance
    theme: string
    noteId?: string | undefined
  }>({
    appearance,
    theme,
  })
  const scroll = useRef<PreviewScrollPane | null>(null)
  const [mounter] = useState(() =>
    createIslandMounter(islands, { scroller: (body) => body.parentElement, shift: shiftScroll }),
  )
  const [codes, setCodes] = useState<HTMLElement[]>([])
  const [opening] = useState(() => createOpening(LONG_NOTE_CHARACTERS))

  const render = useRef<(input: RenderInput) => void>(undefined)
  /** Renders the latest input again. */
  const renderAgain = useRef(() => {})
  const pieces = useRef<ShownPiece[]>([])
  /** The note the pieces on screen are of. */
  const piecesOf = useRef<string | undefined>(undefined)
  /** The Markdown the preview on screen was rendered from (images point into it). */
  const shown = useRef('')
  const findHandle = useRef(onFind)
  const scrollHandle = useRef(onScrollPane)
  const scrollAsked = useRef(initialScroll)
  const scrolled = useRef(onScroll)
  const noteNow = useRef(noteId)
  /** The notes the shown preview links to; their chips are asked for again when one of them changes. */
  const shownLinks = useRef<readonly string[]>([])
  const linksChanged = useRef(0)
  useInsertionEffect(() => {
    if (noteNow.current !== noteId) opening.reset(noteId)
    noteNow.current = noteId
    findHandle.current = onFind
    scrollHandle.current = onScrollPane
    scrollAsked.current = initialScroll
    scrolled.current = onScroll
  })
  const afterBuild = useCallback(() => {
    const el = host.current
    if (!el) return
    const long = shown.current.length > LONG_NOTE_CHARACTERS
    mounter.mount(
      el,
      { ...islandContext.current, eagerFirstMermaid: long ? 'cached' : false },
      () => scroll.current?.changed(),
    )
    const blocks = pieceCodeBlocks(pieces.current)
    opening.clear('commit')
    if (hasPending(pieces.current) || opening.waiting) return
    opening.set(
      'commit',
      afterPaint(() => {
        opening.clear('commit')
        if (blocks.some((block) => !host.current?.contains(block))) return
        const release =
          opening.initial && long ? warmMermaid(shown.current, islandContext.current) : undefined
        if (release) opening.warm(release)
        try {
          mounter.mount(el, { ...islandContext.current, eagerFirstMermaid: true }, () =>
            scroll.current?.changed(),
          )
        } finally {
          if (release) opening.release(release)
        }
        setCodes((now) => (sameList(now, blocks) ? now : blocks))
      }),
    )
  }, [mounter, opening])
  // A big note is built in slices after its first pieces (see `buildPending`); what reads the
  // whole preview (find, select all, copy, a jump to a heading) has the rest built first.
  const buildLater = useCallback(() => {
    if (opening.has('build')) return
    let mountedAt = performance.now()
    const slice = () => {
      opening.clear('build')
      const el = host.current
      if (!el) return
      const until = performance.now() + SLICE_MS
      let first = true
      const count = buildPending(el, pieces.current, () => {
        const more = first || performance.now() < until
        first = false
        return more
      })
      if (count > 0) scroll.current?.built()
      if (hasPending(pieces.current)) {
        if (performance.now() - mountedAt >= MOUNT_EVERY_MS) {
          afterBuild()
          mountedAt = performance.now()
        }
        const timer = setTimeout(slice, 0)
        opening.set('build', () => clearTimeout(timer))
        return
      }
      afterBuild()
    }
    const timer = setTimeout(slice, 0)
    opening.set('build', () => clearTimeout(timer))
  }, [afterBuild, opening])
  const buildAll = useCallback(
    function complete(): void | Promise<boolean> {
      const waiting = opening.waiting
      if (waiting)
        return waiting.done.then((ready) => {
          if (!ready || waiting.note !== noteNow.current || waiting.source !== shown.current)
            return false
          return complete() ?? true
        })
      const el = host.current
      if (!el || !hasPending(pieces.current)) return
      opening.clear('build')
      buildPending(el, pieces.current, () => true)
      scroll.current?.built()
      afterBuild()
    },
    [afterBuild, opening],
  )
  const selectAll = useCallback(() => {
    const note = noteNow.current
    const source = shown.current
    const select = () => {
      if (!pane.current || note !== noteNow.current || source !== shown.current) return false
      selectAllIn(pane.current, window.getSelection())
      return true
    }
    const complete = buildAll()
    if (!complete) {
      select()
      return
    }
    const pending = complete.then((ready) => ready && select())
    opening.select(pending)
    void pending.then(() => {
      if (opening.selection === pending) opening.select(undefined)
    })
  }, [buildAll, opening])
  /** Builds until the preview is `height` tall, in growing runs so layout is read few times. */
  const buildToHeight = useCallback(
    (scroller: HTMLElement, height: number) => {
      const el = host.current
      if (!el) return
      let count = 0
      for (let chars = FIRST_CHARACTERS; hasPending(pieces.current); chars *= 2) {
        if (scroller.scrollHeight >= height) break
        let from: number | undefined
        count += buildPending(el, pieces.current, (piece) => {
          from ??= piece.offset
          return piece.offset < from + chars
        })
      }
      if (count === 0) return
      scroll.current?.built()
      afterBuild()
    },
    [afterBuild],
  )
  const reachLine = useCallback(
    function reach(line: number): void | Promise<boolean> {
      if (!opening.waiting && !hasPending(pieces.current)) return
      const el = host.current
      const scroller = pane.current
      if (!el || !scroller) return
      const target = () => el.querySelector(`[data-source-line="${line}"]`)
      if (!target() && buildToLine(el, pieces.current, line) > 0) {
        scroll.current?.built()
        afterBuild()
      }
      const heading = target()
      if (heading) {
        const top =
          heading.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          scroller.clientTop +
          scroller.scrollTop
        const height = top + scroller.clientHeight
        buildToHeight(scroller, height)
        if (scroller.scrollHeight >= height) return
      }
      const waiting = opening.waiting
      if (waiting) {
        return waiting.done.then((ready) => {
          if (!ready || waiting.note !== noteNow.current || waiting.source !== shown.current)
            return false
          return reach(line) ?? true
        })
      }
    },
    [afterBuild, buildToHeight, opening],
  )
  useEffect(() => () => opening.reset(), [opening])

  // A restored scroll position (see `initialScroll`): asked for at the first
  // render with content, then applied again as the content grows (images,
  // diagrams) until it is reached, the user scrolls, or time runs out.
  const scrollTarget = useRef<{
    top: number
    sizes: ResizeObserver
    expiry: ReturnType<typeof setTimeout>
  }>(undefined)
  const scrollAskedOnce = useRef(false)
  const stopRestoring = useCallback(() => {
    scrollTarget.current?.sizes.disconnect()
    clearTimeout(scrollTarget.current?.expiry)
    scrollTarget.current = undefined
  }, [])
  const keepRestoring = useCallback(() => {
    const target = scrollTarget.current
    const el = pane.current
    if (!target || !el) return
    buildToHeight(el, target.top + el.clientHeight)
    el.scrollTop = target.top
    if (Math.abs(el.scrollTop - target.top) < 1) return stopRestoring()
    for (const child of Array.from(el.children)) target.sizes.observe(child)
  }, [stopRestoring, buildToHeight])
  useEffect(() => stopRestoring, [stopRestoring])

  useEffect(() => {
    if (!pane.current) return
    const target = previewFindTarget(pane.current, { complete: buildAll })
    findHandle.current?.(target)
    const scrolling = previewScrollPane(pane.current, { reach: reachLine })
    scroll.current = scrolling
    scrollHandle.current?.(scrolling)
    return () => {
      target.clear()
      findHandle.current?.(null)
      scrolling.dispose()
      scroll.current = null
      scrollHandle.current?.(null)
    }
  }, [buildAll, reachLine])

  useEffect(() => {
    const { renderLivePreview, noteDrawings } = core
    const request = latestOnly(
      async ({
        input,
        ticket,
        ofNote,
      }: {
        input: RenderInput
        ticket: ReturnType<typeof opening.begin>['request']
        ofNote: string | undefined
      }) => {
        if (!opening.current(ticket)) return undefined
        const source = input.read()
        const valid = () =>
          opening.current(ticket) && ofNote === noteNow.current && source === input.read()
        const ask = async () => {
          const kept =
            ofNote && hasFence(source)
              ? (keptDrawingsOf(ofNote) ??
                (await loadKeptDrawings((id) => noteDrawings(id), ofNote)))
              : undefined
          if (!valid()) return undefined
          const languages = keptLanguages(kept ?? [])
          const rendered = renderLivePreview(
            source,
            {
              labels: previewLabels(),
              ...(languages.length > 0 ? { keptLanguages: languages } : {}),
              loadedEmbeds: input.loadedEmbeds,
              ...(input.remoteImages ? { remoteImages: input.remoteImages } : {}),
              ...(input.frontMatterInInfo ? { frontMatterInInfo: true } : {}),
            },
            ofNote === piecesOf.current ? pieces.current.map((piece) => piece.key) : [],
            `${ofNote ?? ''} ${linksChanged.current}`,
            input.head ? HEAD_CHARACTERS : undefined,
          )
          const next = await rendered
          return valid() ? { next, input, source, ofNote, ticket } : undefined
        }
        return ask().catch((error: unknown) => {
          if (valid()) throw error
          return undefined
        })
      },
      (answer) => {
        if (!answer || !host.current) return
        const { next, input, source, ofNote, ticket } = answer
        if (!opening.current(ticket) || ofNote !== noteNow.current || source !== input.read())
          return
        if (ofNote !== piecesOf.current) {
          // Another note shares nothing worth patching over with the one shown.
          host.current.replaceChildren()
          pieces.current = []
          piecesOf.current = ofNote
        }
        try {
          pieces.current = patchPieces(host.current, pieces.current, next.pieces, { defer: true })
          buildFirstPieces(host.current, pieces.current)
        } catch {
          // The worker counted on a piece the page no longer has: start over.
          console.warn('W_PREVIEW_PIECES_RESET')
          host.current.replaceChildren()
          pieces.current = []
          run(input)
          return
        }
        shown.current = source
        opening.shown(next.partial === true)
        shownLinks.current = next.links
        islandContext.current = { ...islandContext.current, noteId: ofNote }
        afterBuild()
        scroll.current?.rendered(next.lines, pieces.current)
        if (!scrollAskedOnce.current && pieces.current.some((piece) => piece.nodes.length > 0)) {
          scrollAskedOnce.current = true
          const top = scrollAsked.current?.()
          if (top !== undefined) {
            const sizes = new ResizeObserver(keepRestoring)
            // A timer, so a position the note no longer reaches stops being restored without another render.
            const expiry = setTimeout(stopRestoring, RESTORE_SCROLL_MS)
            scrollTarget.current = { top, sizes, expiry }
          }
        }
        keepRestoring()
        if (hasPending(pieces.current)) buildLater()
        if (next.partial) run({ ...input, head: false })
      },
      () => {
        opening.reset(noteNow.current, true)
        console.warn('W_PREVIEW_RENDER_FAILED')
      },
    )
    const run = (input: RenderInput) => {
      const ofNote = noteNow.current
      const source = input.read()
      const next = opening.begin(ofNote, source, input.head)
      request({
        input: {
          ...input,
          head: next.head,
        },
        ticket: next.request,
        ofNote,
      })
    }
    render.current = run
    return () => {
      opening.reset()
      render.current = undefined
    }
  }, [core, afterBuild, buildLater, keepRestoring, stopRestoring, opening])
  useEffect(() => {
    islandContext.current = { ...islandContext.current, appearance, theme }
    if (host.current)
      mounter.mount(host.current, islandContext.current, () => scroll.current?.changed())
  }, [appearance, theme, mounter])

  useEffect(
    () => (host.current ? watchMissingImages(host.current, { anyImage: true }) : undefined),
    [],
  )

  // Leaving the preview frees what its diagrams hold (their stylesheets).
  useEffect(() => () => mounter.dispose(), [mounter])
  // The worker may be gone with the window.
  useEffect(() => () => void core.forgetShownPieces().catch(() => undefined), [core])

  const read = useCallback(() => text.get(), [text])
  // A note opened renders when its text arrives, which follows its id.
  useEffect(
    () => render.current?.({ read, loadedEmbeds, remoteImages, frontMatterInInfo }),
    [read, loadedEmbeds, remoteImages, frontMatterInInfo],
  )
  const input = useRef<RenderInput>({ read, loadedEmbeds, remoteImages, frontMatterInInfo })
  useInsertionEffect(() => {
    input.current = { read, loadedEmbeds, remoteImages, frontMatterInInfo }
  })
  useEffect(() => text.subscribe(() => render.current?.(input.current)), [text])
  useEffect(() => onPluginRenderersChanged(() => render.current?.(input.current)), [])
  useInsertionEffect(() => {
    renderAgain.current = () => render.current?.(input.current)
  })
  useEffect(
    () =>
      watchKeptDrawings(
        () => noteNow.current,
        () => renderAgain.current(),
      ),
    [],
  )
  // Another window or process can change a note a chip shows.
  useEffect(() => {
    const changed = (event: Event) => {
      if (!loadedAny(event, shownLinks.current)) return
      linksChanged.current += 1
      render.current?.(input.current)
    }
    window.addEventListener(NOTES_LOADED, changed)
    return () => window.removeEventListener(NOTES_LOADED, changed)
  }, [])

  const onClick = (event: MouseEvent) => {
    const target = event.target as Element
    const edit = blocksEditable ? target.closest(`[${EDIT_ATTRIBUTE}]`) : null
    const drawing = edit?.closest('[data-block-from]')
    if (drawing) {
      const from = noteOffset(pieces.current, drawing, 'data-block-from')
      const to = noteOffset(pieces.current, drawing, 'data-block-to')
      if (from !== undefined && to !== undefined) editPluginBlock(drawing, { from, to })
      return
    }
    const box = target.closest('input[data-task-at]')
    if (box) {
      // The box shows what the note says: the change comes back as a render.
      event.preventDefault()
      const at = noteOffset(pieces.current, box, 'data-task-at')
      if (at !== undefined) onToggleTask?.(at)
      return
    }
    const remote = target.closest('[data-remote-image-load]')
    if (remote) {
      const site = remote
        .closest('[data-remote-image-host]')
        ?.getAttribute('data-remote-image-host')
      if (site) loadImagesFrom(site)
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
      const note = noteNow.current
      const complete = buildAll()
      const id = fragmentId(decodeURIComponent(href.slice(1)))
      const jump = () => {
        if (note === noteNow.current)
          pane.current
            ?.querySelector(`[id="${CSS.escape(id)}"]`)
            ?.scrollIntoView({ block: 'start' })
      }
      if (complete)
        void complete.then((ready) => {
          if (ready) jump()
        })
      else jump()
      return
    }
    const note = NOTE_LINK.exec(href)
    if (note?.[1]) onOpenNote(note[1])
    else if (/^https:\/\//i.test(href)) {
      invoke('open_external', { url: href }).catch(() => console.warn('W_OPEN_EXTERNAL_FAILED'))
    } else if (href !== '') {
      // Only https links leave Devot; an http: or mailto: link says so
      // rather than doing nothing at all.
      setRefusedLink(href)
    }
  }

  const imageUnder = (event: MouseEvent) => {
    const target = event.target
    return target instanceof HTMLImageElement && host.current?.contains(target) ? target : null
  }
  const onDoubleClick = (event: MouseEvent) => {
    const img = imageUnder(event)
    if (!img || !onOpenImage || isMissingImage(img)) return
    event.preventDefault()
    onOpenImage({ src: img.currentSrc || img.src, alt: img.alt })
  }
  const menuAt = useRef<MenuPoint>({ x: 0, y: 0 })
  const pickMenuAction = useCallback(
    (action: PreviewAction, target: PreviewMenuTarget) => {
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
          selectAll()
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
    },
    [selectAll],
  )
  const showMenu = useContextMenu('preview', PREVIEW_MENU, pickMenuAction)
  const onContextMenu = (event: MouseEvent) => {
    const at = { x: event.clientX, y: event.clientY }
    const img = imageUnder(event)
    if (img) {
      if (!onImageMenu) return
      const image = previewImageTarget(img, shown.current, pieces.current)
      // An image the menu has nothing for keeps the web view's own menu.
      if (!imageMenuHasItems(image)) return
      event.preventDefault()
      onImageMenu(image, at)
      return
    }
    const target = event.target as Element
    // Text fields keep the web view's own menu.
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
      <PreviewFrameContent
        blocksEditable={blocksEditable}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onCopy={(event) => {
          const pending = opening.selection
          if (!opening.waiting) {
            buildAll()
            if (pending && pane.current) selectAllIn(pane.current, window.getSelection())
            opening.select(undefined)
            return
          }
          if (!pending) {
            buildAll()
            return
          }
          event.preventDefault()
          const note = noteNow.current
          const source = shown.current
          const selection = pending.then(
            (ready) =>
              ready && note === noteNow.current && source === shown.current
                ? window.getSelection()
                : null,
            () => null,
          )
          void copySelection(selection).catch(async () => {
            if ((await selection) && note === noteNow.current && source === shown.current) {
              buildAll()
              if (pane.current) selectAllIn(pane.current, window.getSelection())
              console.warn('W_PREVIEW_COPY_FAILED')
            }
          })
        }}
        // Scrolling by the user ends a restore; scrolls made by it are not reported.
        onWheel={stopRestoring}
        onPointerDown={stopRestoring}
        onKeyDown={(event) => {
          stopRestoring()
          // Select all runs after this, over a preview built whole.
          if (keyMatches('Mod+A', event)) {
            event.preventDefault()
            selectAll()
          }
        }}
        onScroll={(event) => {
          if (!scrollTarget.current) scrolled.current?.(event.currentTarget.scrollTop)
        }}
      >
        <div ref={host} className="preview-body" />
        {refusedLink ? (
          <div className="notice preview-notice" data-devot-part="notice">
            <span className="notice-text" role="status">
              {format(t('preview.linkRefused'), { href: refusedLink })}
            </span>
            <button
              type="button"
              className="button"
              onClick={() =>
                void copyText(refusedLink).catch(() => console.warn('W_LINK_COPY_FAILED'))
              }
            >
              {t('preview.copyLink')}
            </button>
            <button type="button" className="button" onClick={() => setRefusedLink(undefined)}>
              {t('notice.dismiss')}
            </button>
          </div>
        ) : null}
      </PreviewFrameContent>
      <CodeCopyButtons blocks={codes} />
      <NoteHover pane={pane} load={previewsFor(core)} />
    </>
  )
}
