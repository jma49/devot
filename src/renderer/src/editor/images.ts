// Images in the note editor: finding them, setting their size (see
// core/images.ts), and showing attachments under their lines.
//
// Previews are block widgets under each line that shows an attachment, from
// a state field (only decorations from the state may change the editor's
// vertical layout). Each block has one fixed height, known before its images
// load, so lines never move as images arrive or fail. CodeMirror only draws
// the visible part of a note, so only visible images load. Finding the
// images scans the text for `![` and asks the syntax tree only there, which
// stays cheap for long notes (the scan reads the document's own line
// strings, copying nothing). Only attachments (devot://file) show: the
// production CSP loads no remote images.
import { syntaxTree } from '@codemirror/language'
import { Facet, StateField, type EditorState, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import {
  attachmentId,
  parseImageMarkdown,
  withImageSize,
  type ImageSize,
} from '../../../core/images'
import type { MenuPoint } from '../contextMenu'
import { sizes } from '../theme/tokens'

/** An inline image (`![alt](url)`) in the editor's text. */
export interface EditorImage {
  from: number
  to: number
  /** Its Markdown, as it was when found. */
  text: string
  alt: string
  /** The URL without its size. */
  url: string
  /** The attachment it shows, if it is one. */
  fileId: string | null
  size: ImageSize
  /** Whether a size can be set (its URL has no other fragment). */
  sizable: boolean
}

/** What the window does with an image in the editor (set by the note editor). */
export interface ImageActions {
  /** Double-click: show the image in the viewer. */
  open(image: { src: string; alt: string }): void
  /** Right-click: the image menu, at a point in the window. */
  menu(image: EditorImage, at: MenuPoint): void
}

export const imageActions = Facet.define<ImageActions, ImageActions | null>({
  combine: (values) => values[0] ?? null,
})

/** The inline image whose syntax starts at `pos`, if there is one. */
function imageNodeAt(state: EditorState, pos: number): { from: number; to: number } | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos + 1, 1)
  for (; node; node = node.parent) {
    if (node.name === 'Image') return node.from === pos ? { from: node.from, to: node.to } : null
  }
  return null
}

/** The inline images that start between `from` and `to`, in order. */
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
          sizable: image.sizable,
        })
      }
    }
    pos += chunk.length
  }
  return out
}

/** The image at `pos`, or else the first on its line; null when the line has none. */
export function imageAt(state: EditorState, pos: number): EditorImage | null {
  const line = state.doc.lineAt(pos)
  const images = findImages(state, line.from, line.to)
  return images.find((i) => i.from <= pos && pos <= i.to) ?? images[0] ?? null
}

/**
 * Shows the attachment image at `pos`, or else the first on its line, in the
 * viewer (what a double-click on its preview does); false when the line has
 * none.
 */
export function viewImageAt(view: EditorView, pos = view.state.selection.main.head): boolean {
  const image = imageAt(view.state, pos)
  const open = view.state.facet(imageActions)?.open
  if (!image?.fileId || !open) return false
  open({ src: new URL(image.url, document.baseURI).href, alt: image.alt })
  return true
}

/**
 * The change that gives `image` this size, replacing only its destination;
 * null when the text there is no longer that image or it cannot take a size.
 */
export function imageSizeChange(
  state: EditorState,
  image: Pick<EditorImage, 'from' | 'to' | 'text'>,
  size: ImageSize,
): TransactionSpec | null {
  if (image.to > state.doc.length || state.sliceDoc(image.from, image.to) !== image.text)
    return null
  const parsed = parseImageMarkdown(image.text)
  if (!parsed?.sizable) return null
  const insert = withImageSize(parsed.url, size)
  const { from, to } = parsed.dest
  if (image.text.slice(from, to) === insert) return {}
  return {
    changes: { from: image.from + from, to: image.from + to, insert },
    userEvent: 'input.image.size',
  }
}

/** A line with attachments to show under it: where the block goes, and its images. */
export interface ImageLine {
  at: number
  images: EditorImage[]
}

/** The lines that show attachments, in order, each with the images that end on it. */
export function imageLines(state: EditorState): ImageLine[] {
  const byLine = new Map<number, EditorImage[]>()
  for (const image of findImages(state)) {
    if (!image.fileId) continue
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
      img.addEventListener('error', () => img.classList.add('cm-inline-image-failed'))
      img.src = url
      box.appendChild(img)
    }
    /** The image under the event, found again in the text as it is now. */
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
    return box
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

/** The previews' decorations, rebuilt when the text or its syntax tree changes. */
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
    padding: 'var(--space-2) 0',
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
})

/** Attachments shown under their lines (Settings > Editor > Show images). */
export const inlineImages = [inlineImageField, theme]
