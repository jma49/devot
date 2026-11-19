import remarkParse from 'remark-parse'
import { unified } from 'unified'

export async function storeImageLinks(
  markdown: string,
  upload: (url: string) => Promise<string>,
): Promise<string> {
  const images: { url: string; start: number; end: number }[] = []
  unified()
    .use(remarkParse)
    .data('fromMarkdownExtensions', [
      {
        exit: {
          resourceDestination(token) {
            const node = this.stack.at(-1)
            if (node?.type !== 'image' || !/^https?:\/\//.test(node.url)) return
            const enclosed = markdown[token.start.offset] === '<'
            images.push({
              url: node.url,
              start: token.start.offset + (enclosed ? 1 : 0),
              end: token.end.offset - (enclosed ? 1 : 0),
            })
          },
        },
      },
    ])
    .parse(markdown)
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
    if (url) markdown = markdown.slice(0, image.start) + url + markdown.slice(image.end)
  }
  return markdown
}
