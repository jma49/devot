// Images in the note editor: finding them, setting their size (see core/images.ts) and showing them under their lines.
// Previews are block widgets from a state field (only state decorations may change the editor's vertical layout),
// each with one fixed height known before its images load, so lines never move as images arrive or fail. Finding
// images scans the text for `![` and asks the syntax tree only there, which stays cheap on long notes. Attachments
// (devot://file) and https images show; the app's CSP loads no plain http images.
import { syntaxTree } from '@codemirror/language'
import { Facet, StateField, type EditorState, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import {
  attachmentId,
  parseImageMarkdown,
  setImageMarkdownSize,
  type ImageDimensions,
  type ImageSize,
} from '../../../core/images'
import type { MenuPoint } from '../contextMenu'
import { isMissingImage, MISSING_IMAGE, watchMissingImages } from '../missingImages'
import { sizes } from '../theme/tokens'

export interface EditorImage {
  from: number
  to: number
  text: string
  alt: string
  url: string
  fileId: string | null
  size: ImageSize
  /** A size that is no preset (`w:320 h:240`), else null. */
  dimensions: ImageDimensions | null
  sizable: boolean
}

export interface ImageActions {
  open(image: { src: string; alt: string }): void
  menu(image: EditorImage, at: MenuPoint): void
}

export const imageActions = Facet.define<ImageActions, ImageActions | null>({
  combine: (values) => values[0] ?? null,
})

function imageNodeAt(state: EditorState, pos: number): { from: number; to: number } | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos + 1, 1)
  for (; node; node = node.parent) {
    if (node.name === 'Image') return node.from === pos ? { from: node.from, to: node.to } : null
  }
  return null
}

export function findImages(state: EditorState, from = 0, to = state.doc.length): EditorImage[] {
  const out: EditorImage[] = []
  // The document's own line strings, without copying them: cheap on long notes.
  let pos = from
  for (const lines = state.doc.iterRange(from, to); !lines.next().done;) {
    const chunk = lines.value
    if (!lines.lineBreak) {
      for (let at = chunk.indexOf('!['); at >= 0; at = chunk.indexOf('![', at + 2)) {
        const node = imageNodeAt(state, pos + at)
        if (!node) continue
        const text = state.sliceDoc(node.from, node.to)
        const image = parseImageMarkdown(text)
        if (!image) continue
        out.push({
          from: node.from,
          to: node.to,
          text,
          alt: image.alt,
          url: image.url,
          fileId: attachmentId(image.url),
          size: image.size,
          dimensions: image.dimensions,
          sizable: image.sizable,
        })
      }
    }
    pos += chunk.length
  }
  return out
}

export function imageAt(state: EditorState, pos: number): EditorImage | null {
  const line = state.doc.lineAt(pos)
  const images = findImages(state, line.from, line.to)
  return images.find((i) => i.from <= pos && pos <= i.to) ?? images[0] ?? null
}

export function imageAtCaret(state: EditorState): EditorImage | null {
  const { main } = state.selection
  if (!main.empty) return null
  const line = state.doc.lineAt(main.head)
  return (
    findImages(state, line.from, line.to).find((i) => i.from <= main.head && main.head <= i.to) ??
    null
  )
}

function shows(image: EditorImage): boolean {
  return image.fileId !== null || /^https:\/\/[^/]/i.test(image.url)
}

/** Shows the image at `pos`, or else the first on its line, in the viewer; false when the line has none. */
export function viewImageAt(view: EditorView, pos = view.state.selection.main.head): boolean {
  const image = imageAt(view.state, pos)
  const open = view.state.facet(imageActions)?.open
  if (!image || !shows(image) || !open) return false
  open({ src: new URL(image.url, document.baseURI).href, alt: image.alt })
  return true
}

/**
 * The change that gives `image` this size (written in its alt text, see
 * core/images.ts); null when the text there is no longer that image.
 */
export function imageSizeChange(
  state: EditorState,
  image: Pick<EditorImage, 'from' | 'to' | 'text'>,
  size: ImageSize,
): TransactionSpec | null {
  if (image.to > state.doc.length || state.sliceDoc(image.from, image.to) !== image.text)
    return null
  const written = setImageMarkdownSize(image.text, size)
  if (written === null) return null
  if (written === image.text) return {}
  // Only the part that differs, so the cursor and marks around it stay put.
  let start = 0
  while (start < written.length && written[start] === image.text[start]) start += 1
  let end = 0
  while (
    end < written.length - start &&
    end < image.text.length - start &&
    written[written.length - 1 - end] === image.text[image.text.length - 1 - end]
  )
    end += 1
  return {
    changes: {
      from: image.from + start,
      to: image.to - end,
      insert: written.slice(start, written.length - end),
    },
    userEvent: 'input.image.size',
  }
}

export interface ImageLine {
  at: number
  images: EditorImage[]
}

export function imageLines(state: EditorState): ImageLine[] {
  const byLine = new Map<number, EditorImage[]>()
  for (const image of findImages(state)) {
    if (!shows(image)) continue
    const at = state.doc.lineAt(image.to).to
    const images = byLine.get(at)
    if (images) images.push(image)
    else byLine.set(at, [image])
  }
  // An image may end on a later line than one that starts after it (an image
  // inside another's alt text across lines), so the lines are sorted.
  return Array.from(byLine, ([at, images]) => ({ at, images })).sort((a, b) => a.at - b.at)
}

const HEIGHT = Number.parseFloat(sizes['size.inline-image-height'])

const stops = new WeakMap<HTMLElement, () => void>()

/** The images under one line. Only their URLs and alt texts matter for redrawing. */
class ImagesWidget extends WidgetType {
  constructor(readonly images: readonly { url: string; alt: string }[]) {
    super()
  }

  override eq(other: ImagesWidget): boolean {
    return (
      other.images.length === this.images.length &&
      other.images.every((i, n) => i.url === this.images[n]?.url && i.alt === this.images[n]?.alt)
    )
  }

  override get estimatedHeight(): number {
    return HEIGHT
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-inline-images'
    // The Markdown line above already names each image.
    box.setAttribute('aria-hidden', 'true')
    for (const { url, alt } of this.images) {
      const img = document.createElement('img')
      img.className = 'cm-inline-image'
      img.alt = alt
      img.draggable = false
      img.addEventListener('error', () => {
        if (!isMissingImage(img)) img.classList.add('cm-inline-image-failed')
      })
      img.src = url
      box.appendChild(img)
    }
    const target = (event: Event): { img: HTMLImageElement; image: EditorImage | null } | null => {
      const img = event.target instanceof HTMLImageElement ? event.target : null
      if (!img) return null
      const index = Array.prototype.indexOf.call(box.children, img)
      const at = view.state.doc.lineAt(view.posAtDOM(box)).to
      const shown = imageLines(view.state).find((line) => line.at === at)?.images ?? []
      return { img, image: shown[index] ?? null }
    }
    box.addEventListener('dblclick', (event) => {
      const hit = target(event)
      if (!hit) return
      event.preventDefault()
      view.state.facet(imageActions)?.open({ src: hit.img.src, alt: hit.img.alt })
    })
    box.addEventListener('contextmenu', (event) => {
      const hit = target(event)
      if (!hit?.image) return
      event.preventDefault()
      view.state.facet(imageActions)?.menu(hit.image, { x: event.clientX, y: event.clientY })
    })
    stops.set(box, watchMissingImages(box))
    return box
  }

  override destroy(dom: HTMLElement): void {
    stops.get(dom)?.()
    stops.delete(dom)
  }

  /** The editor leaves pointer events to the images; drops still go to the editor. */
  override ignoreEvent(event: Event): boolean {
    return !event.type.startsWith('drag') && event.type !== 'drop'
  }
}

function decorations(state: EditorState): DecorationSet {
  return Decoration.set(
    imageLines(state).map((line) =>
      Decoration.widget({
        widget: new ImagesWidget(line.images.map(({ url, alt }) => ({ url, alt }))),
        block: true,
        side: 1,
      }).range(line.at),
    ),
  )
}

export const inlineImageField = StateField.define<DecorationSet>({
  create: decorations,
  update: (value, tr) =>
    tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)
      ? decorations(tr.state)
      : value,
  provide: (field) => EditorView.decorations.from(field),
})

const theme = EditorView.theme({
  '.cm-inline-images': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--space-4)',
    boxSizing: 'border-box',
    height: 'var(--size-inline-image-height)',
    // In from the content's edge as a line's text is (CodeMirror pads it by space-3).
    padding: 'var(--space-2) 0 var(--space-2) var(--space-3)',
    overflow: 'hidden',
  },
  '.cm-inline-image': {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    borderRadius: 'var(--radius-button)',
    cursor: 'zoom-in',
  },
  '.cm-inline-image-failed': { visibility: 'hidden' },
  // An attachment that has not arrived: a box where the image will be.
  [`.cm-inline-image.${MISSING_IMAGE}`]: {
    height: '100%',
    aspectRatio: '4 / 3',
    background: 'var(--color-fill-track)',
    cursor: 'default',
  },
})

export const inlineImages = [inlineImageField, theme]
