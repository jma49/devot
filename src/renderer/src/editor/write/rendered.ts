// Write mode's block widgets: an image, a formula, a diagram or an embed shown
// as the preview shows it. The block's Markdown goes through the preview's own
// renderers (the core, sanitised) and the tree is built with DOM APIs
// (preview/dom.ts), so no HTML from the note reaches the editor any other way;
// diagrams are the preview's islands. A box keeps the height its block had
// last, or the one its image is known to have, until its content is in place.
// A click puts the caret in the block's source; a double click on an image
// opens the viewer.
import { Facet, type Extension } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import type { RootContent } from 'hast'
import { isMissingImage, watchMissingImages } from '../../missingImages'
import { patchChildren } from '../../preview/dom'
import { islands } from '../../preview/islandRegistry'
import { createIslandMounter, ISLAND_ATTRIBUTE, type IslandMounter } from '../../preview/islands'
import { shownAppearance, shownTheme, subscribeAppearance } from '../../theme/appearance'
import { findImages, imageActions } from '../images'
import { parseImageMarkdown } from '../../../../core/images'
import { imageEntry, writeBlocksOf, type BlockLook, type WriteBlock } from './blockRanges'

export interface WriteRenderer {
  /** `markdown` as the preview renders it: the sanitised tree of its blocks. */
  render(markdown: string, loadedEmbeds: readonly string[]): Promise<readonly RootContent[]>
}

export const writeRenderer = Facet.define<WriteRenderer, WriteRenderer | null>({
  combine: (values) => values[0] ?? null,
})

/** Most recently used first out: maps keep insertion order. */
class Recent<V> {
  private readonly map = new Map<string, V>()
  constructor(private readonly limit: number) {}
  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) {
      this.map.delete(key)
      this.map.set(key, value)
    }
    return value
  }
  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as string)
  }
}

const trees = new Recent<readonly RootContent[]>(200)
const heights = new Recent<number>(1000)
const imageSizes = new Recent<{ width: number; height: number }>(1000)
const loadedEmbeds = new WeakMap<EditorView, string[]>()

/** How long a box keeps its reserved height at most while what it shows loads. */
const SETTLE_MS = 3000
/** Guesses for a block never drawn, in pixels; the drawn height replaces them. */
const GUESS = { image: 240, math: 72, diagram: 280, embed: 320 } as const
/** The space around an image in its box, learned from the first one drawn. */
let imageChrome = 48
let contentWidth = 0

const embedsOf = (view: EditorView) => loadedEmbeds.get(view) ?? []
const keyOf = (block: WriteBlock, embeds: readonly string[]) =>
  `${block.kind}\u0000${block.source}${block.kind === 'embed' ? `\u0000${embeds.join(' ')}` : ''}`

const learning = new Set<string>()

/** Loads an image's size before its widget is drawn, so its box can be the right height. */
function learnImage(url: string): void {
  if (learning.has(url) || imageSizes.get(url) || typeof Image === 'undefined') return
  learning.add(url)
  const img = new Image()
  const done = () => learning.delete(url)
  img.addEventListener('error', done)
  img.addEventListener('load', () => {
    done()
    if (img.naturalWidth > 0)
      imageSizes.set(url, { width: img.naturalWidth, height: img.naturalHeight })
  })
  img.src = url
}

function imageHeight(block: WriteBlock): number | null {
  if (contentWidth <= 0) return null
  let total = 0
  for (const image of parseLine(block.source)) {
    const known = imageSizes.get(image.url)
    if (!known) return null
    const room = contentWidth - imageChrome
    const width =
      image.size === 'full'
        ? room
        : image.size === 'half'
          ? room / 2
          : Math.min(image.size === 'small' ? 240 : known.width, room)
    total = Math.max(total, (width * known.height) / known.width)
  }
  return total + imageChrome
}

function parseLine(source: string): { url: string; size: string }[] {
  const out: { url: string; size: string }[] = []
  for (const match of source.matchAll(/!\[[^\]]*\]\([^)]*\)/g)) {
    const image = parseImageMarkdown(match[0])
    if (image) out.push({ url: image.url, size: image.size })
  }
  return out
}

/** How far the pointer may move between the clicks of a double click, in pixels. */
const CLICK_SLOP = 4

/**
 * The image the last click went to. Its click shows its source over it, which
 * moves it down: a double click opens it wherever the second click lands.
 */
let clicked: {
  view: EditorView
  src: string
  alt: string
  x: number
  y: number
  time: number
} | null = null

/** Longer than any double-click interval the system allows. */
const DOUBLE_CLICK_MS = 1000

function openClicked(view: EditorView, event: MouseEvent): boolean {
  const at = clicked
  if (event.detail <= 1) clicked = null
  if (
    event.detail !== 2 ||
    at?.view !== view ||
    event.timeStamp - at.time > DOUBLE_CLICK_MS ||
    Math.abs(event.clientX - at.x) > CLICK_SLOP ||
    Math.abs(event.clientY - at.y) > CLICK_SLOP
  )
    return false
  clicked = null
  event.preventDefault()
  view.state.facet(imageActions)?.open({ src: at.src, alt: at.alt })
  return true
}

/** The second click of a double click on an image may land on the source the first one showed. */
export const imageDoubleClick: Extension = EditorView.domEventHandlers({
  mousedown: (event, view) => event.button === 0 && openClicked(view, event),
})

interface Drawn {
  key: string
  block: WriteBlock
  mounter: IslandMounter
  stops: (() => void)[]
  draw: (embeds: readonly string[]) => void
}

const drawn = new WeakMap<HTMLElement, Drawn>()

function setLook(box: HTMLElement, look: BlockLook): void {
  box.classList.toggle('cm-wm-block-selected', look === 'selected')
  box.classList.toggle('cm-wm-block-open', look === 'open')
}

/** The block this widget stands for now: positions move as the note changes. */
function blockOf(view: EditorView, box: HTMLElement): WriteBlock | null {
  const at = view.posAtDOM(box)
  // A closed block's widget stands at its start, an open one's under its source.
  return writeBlocksOf(view.state).find((b) => b.from === at || b.to === at) ?? null
}

export class RenderedBlockWidget extends WidgetType {
  constructor(
    readonly block: WriteBlock,
    readonly look: BlockLook,
  ) {
    super()
    if (block.kind === 'image') for (const { url } of parseLine(block.source)) learnImage(url)
  }

  override eq(other: RenderedBlockWidget): boolean {
    return (
      other.block.kind === this.block.kind &&
      other.block.source === this.block.source &&
      other.look === this.look
    )
  }

  /** The box stays: a block whose source changed keeps showing the last rendering until the new one is in place. */
  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const shown = drawn.get(dom)
    if (!shown || shown.block.kind !== this.block.kind) return false
    const changed = shown.block.source !== this.block.source
    shown.block = this.block
    setLook(dom, this.look)
    if (changed) shown.draw(embedsOf(view))
    return true
  }

  override get estimatedHeight(): number {
    const known = heights.get(keyOf(this.block, []))
    if (known !== undefined) return known
    return (this.block.kind === 'image' ? imageHeight(this.block) : null) ?? GUESS[this.block.kind]
  }

  override toDOM(view: EditorView): HTMLElement {
    contentWidth = view.contentDOM.clientWidth || contentWidth
    const block = this.block
    const box = document.createElement('div')
    box.className = `cm-wm-block cm-wm-block-${block.kind}`
    setLook(box, this.look)
    const page = document.createElement('div')
    page.className = 'preview cm-wm-block-page'
    const body = document.createElement('div')
    body.className = 'preview-body'
    page.append(body)
    box.append(page)
    const shown: Drawn = {
      key: keyOf(block, embedsOf(view)),
      block,
      mounter: createIslandMounter(islands),
      stops: [],
      draw: () => undefined,
    }
    drawn.set(box, shown)
    shown.stops.push(watchMissingImages(body, { anyImage: true }))

    // The box keeps a height while what it shows arrives: the one known for the
    // block at first, then the one it had while a changed source draws again.
    let timer: ReturnType<typeof setTimeout> | undefined
    let islandsDrawn = false
    const hold = (height: number) => {
      box.style.minHeight = `${height}px`
      clearTimeout(timer)
      timer = setTimeout(release, SETTLE_MS)
    }
    const release = () => {
      clearTimeout(timer)
      box.style.minHeight = ''
      view.requestMeasure()
    }
    shown.stops.push(() => clearTimeout(timer))
    const settle = () => {
      if (Array.from(body.querySelectorAll('img')).some((img) => !img.complete)) return
      if (!islandsDrawn && body.querySelector(`[${ISLAND_ATTRIBUTE}]`)) return
      release()
      const height = box.getBoundingClientRect().height
      if (height <= 0) return
      heights.set(keyOf(shown.block, []), height)
      const img = shown.block.kind === 'image' ? body.querySelector('img') : null
      if (img && img.naturalWidth > 0) {
        imageChrome = Math.max(0, height - img.getBoundingClientRect().height)
        imageSizes.set(img.getAttribute('src') ?? '', {
          width: img.naturalWidth,
          height: img.naturalHeight,
        })
      }
    }
    hold(this.estimatedHeight)

    const context = () => ({
      appearance: shownAppearance(),
      theme: shownTheme(),
      styleRoot: view.root,
    })
    const place = (nodes: readonly RootContent[]) => {
      if (box.isConnected && !box.style.minHeight) hold(box.getBoundingClientRect().height)
      islandsDrawn = false
      patchChildren(body, nodes)
      for (const img of body.querySelectorAll('img')) {
        img.draggable = false
        const known = imageSizes.get(img.getAttribute('src') ?? '')
        if (known && !img.hasAttribute('width') && !img.hasAttribute('height')) {
          img.width = known.width
          img.height = known.height
        }
        img.addEventListener('load', settle)
        img.addEventListener('error', settle)
      }
      shown.mounter.mount(body, context(), () => {
        islandsDrawn = true
        settle()
        view.requestMeasure()
      })
      settle()
    }
    const draw = (embeds: readonly string[]) => {
      const now = shown.block
      const key = keyOf(now, embeds)
      shown.key = key
      const known = trees.get(key)
      if (known) return place(known)
      const renderer = view.state.facet(writeRenderer)
      if (!renderer) return
      renderer.render(now.source, embeds).then(
        (nodes) => {
          trees.set(key, nodes)
          if (shown.key === key && drawn.get(box) === shown) place(nodes)
        },
        () => console.warn('W_WRITE_BLOCK_RENDER_FAILED', now.kind),
      )
    }
    shown.draw = draw
    draw(embedsOf(view))
    shown.stops.push(
      subscribeAppearance(() => shown.mounter.mount(body, context(), () => view.requestMeasure())),
    )

    const imageAt = (img: HTMLImageElement, now: WriteBlock) => {
      const index = Array.prototype.indexOf.call(body.querySelectorAll('img'), img)
      return findImages(view.state, now.from, now.to)[index] ?? null
    }
    box.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      if (openClicked(view, event)) return
      const target = event.target as Element
      if (target.closest('[data-embed-load]')) return
      const now = blockOf(view, box)
      if (!now) return
      let entry = now.entry
      if (target instanceof HTMLImageElement) {
        const image = imageAt(target, now)
        if (image) entry = imageEntry(image)
        if (!isMissingImage(target)) {
          const src = target.currentSrc || target.src
          clicked = {
            view,
            src,
            alt: target.alt,
            x: event.clientX,
            y: event.clientY,
            time: event.timeStamp,
          }
        }
      }
      view.dispatch({ selection: { anchor: entry }, userEvent: 'select.pointer' })
      view.focus()
    })
    box.addEventListener('click', (event) => {
      const load = (event.target as Element).closest('[data-embed-load]')
      if (!load) return
      const src = load.closest('[data-embed-src]')?.getAttribute('data-embed-src')
      if (!src) return
      const embeds = embedsOf(view)
      if (!embeds.includes(src)) loadedEmbeds.set(view, [...embeds, src])
      draw(embedsOf(view))
    })
    box.addEventListener('contextmenu', (event) => {
      const target = event.target
      if (!(target instanceof HTMLImageElement)) return
      const now = blockOf(view, box)
      const actions = view.state.facet(imageActions)
      const image = now && actions ? imageAt(target, now) : null
      if (!image || !actions) return
      event.preventDefault()
      actions.menu(image, { x: event.clientX, y: event.clientY })
    })
    return box
  }

  override destroy(dom: HTMLElement): void {
    const shown = drawn.get(dom)
    if (!shown) return
    drawn.delete(dom)
    for (const stop of shown.stops) stop()
    shown.mounter.dispose()
  }

  /** The editor leaves pointer events to the widget; drops still go to the editor. */
  override ignoreEvent(event: Event): boolean {
    return !event.type.startsWith('drag') && event.type !== 'drop'
  }
}
