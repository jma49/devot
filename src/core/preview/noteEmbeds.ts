// Note embeds: `![title](devot://note/<id>)` alone in a paragraph shows the note's body in its place, under a chip
// that opens it. The body is rendered once, a level deep: a note it embeds in turn is a link, so no cycle repeats.
// What is embedded is read-only (no task boxes, no offsets into the host note, no ids or footnotes of its own).
// Without the targets (exported pages), an embed inline in text or past MAX_NOTE_EMBEDS, it is a note link.
import type { Element, ElementContent, Root, RootContent } from 'hast'
import { chip } from './noteLinks'
import {
  PIECE_OFFSET_PROPERTIES,
  PREVIEW_API_VERSION,
  type NoteLinkTarget,
  type PreviewOptions,
  type PreviewRenderer,
} from './registry'

export const NOTE_EMBEDS_ID = 'devot.note-embeds'

const NOTE_SRC = /^devot:\/\/note\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export type RenderEmbedded = (
  markdown: string,
  options: Omit<PreviewOptions, 'noteLinks' | 'note'>,
) => Promise<RootContent[]>

type Parent = Root | Element

const isBlank = (node: RootContent | ElementContent) =>
  node.type === 'text' && node.value.trim() === ''

const embeddedId = (node: ElementContent | RootContent): string | undefined => {
  if (node.type !== 'element' || node.tagName !== 'img') return undefined
  const src = node.properties['src']
  return typeof src === 'string' ? NOTE_SRC.exec(src.split('#')[0]!)?.[1] : undefined
}

function asLink(img: Element, id: string): Element {
  const alt = img.properties['alt']
  return {
    type: 'element',
    tagName: 'a',
    properties: { href: `devot://note/${id}` },
    children: [{ type: 'text', value: typeof alt === 'string' ? alt : '' }],
    ...(img.position ? { position: img.position } : {}),
  }
}

const DROPPED = ['id', 'ariaDescribedBy', ...PIECE_OFFSET_PROPERTIES]

function readOnly(nodes: (RootContent | ElementContent)[]): (RootContent | ElementContent)[] {
  const out: (RootContent | ElementContent)[] = []
  for (const node of nodes) {
    if (node.type !== 'element') {
      out.push(node)
      continue
    }
    if (node.tagName === 'section' && node.properties['dataFootnotes'] !== undefined) continue
    if (node.tagName === 'a' && node.properties['dataFootnoteRef'] !== undefined) continue
    for (const key of DROPPED) delete node.properties[key]
    if (node.tagName === 'input') node.properties['disabled'] = true
    const nested = embeddedId(node)
    if (nested) {
      out.push(asLink(node, nested))
      continue
    }
    node.children = readOnly(node.children) as ElementContent[]
    out.push(node)
  }
  return out
}

async function embedBlock(
  id: string,
  target: NoteLinkTarget & { embed: NonNullable<NoteLinkTarget['embed']> },
  untitled: string,
  render: RenderEmbedded,
  options: PreviewOptions,
): Promise<Element> {
  const { noteLinks: _links, note: _note, ...inner } = options
  const body = readOnly(await render(target.embed.markdown, inner)) as ElementContent[]
  return {
    type: 'element',
    tagName: 'div',
    properties: {
      className: target.embed.clipped ? ['note-embed', 'note-embed-clipped'] : ['note-embed'],
      dataNoteEmbed: id,
    },
    children: [
      {
        type: 'element',
        tagName: 'a',
        properties: { href: `devot://note/${id}`, className: ['note-chip', 'note-embed-title'] },
        children: chip(target, untitled),
      },
      {
        type: 'element',
        tagName: 'div',
        properties: { className: ['note-embed-body'] },
        children: body,
      },
    ],
  }
}

/** With `render`, embeds show their note; without it (inside an embed, a card or a plugin's answer) they are links. */
export function createNoteEmbeds(render?: RenderEmbedded): PreviewRenderer {
  return {
    id: NOTE_EMBEDS_ID,
    apiVersion: PREVIEW_API_VERSION,
    async transform(tree, options) {
      const targets = render ? options.noteLinks : undefined
      const visit = async (parent: Parent) => {
        const out: RootContent[] = []
        for (const child of parent.children) {
          if (child.type !== 'element') {
            out.push(child)
            continue
          }
          const id = embeddedId(child)
          if (id) {
            out.push(asLink(child, id))
            continue
          }
          const content = child.tagName === 'p' ? child.children.filter((c) => !isBlank(c)) : []
          const only = content.length === 1 ? content[0]! : undefined
          const alone = only ? embeddedId(only) : undefined
          const target =
            alone && targets && Object.hasOwn(targets, alone) ? targets[alone] : undefined
          if (alone && target?.embed && render) {
            const block = await embedBlock(
              alone,
              { ...target, embed: target.embed },
              options.labels.untitled,
              render,
              options,
            )
            if (child.position) block.position = child.position
            out.push(block)
            continue
          }
          await visit(child)
          out.push(child)
        }
        parent.children = out as typeof parent.children
      }
      await visit(tree)
    },
  }
}
