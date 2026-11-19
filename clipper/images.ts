import type { Image, Nodes } from 'mdast'
import { toMarkdown } from 'mdast-util-to-markdown'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export async function storeImageLinks(
  markdown: string,
  upload: (url: string) => Promise<string>,
): Promise<string> {
  const images: Image[] = []
  const walk = (node: Nodes): void => {
    if (node.type === 'image' && /^https?:\/\//.test(node.url)) images.push(node)
    if ('children' in node) for (const child of node.children) walk(child)
  }
  walk(unified().use(remarkParse).parse(markdown))
  const stored = new Map<string, string>()
  for (const url of [...new Set(images.map((image) => image.url))].slice(0, 50)) {
    try {
      stored.set(url, await upload(url))
    } catch {
      /* A refused image stays remote. */
    }
  }
  for (const image of images.reverse()) {
    const url = stored.get(image.url)
    const start = image.position?.start.offset
    const end = image.position?.end.offset
    if (!url || start === undefined || end === undefined) continue
    image.url = url
    const replacement = toMarkdown({
      type: 'root',
      children: [{ type: 'paragraph', children: [image] }],
    }).trim()
    markdown = markdown.slice(0, start) + replacement + markdown.slice(end)
  }
  return markdown
}
