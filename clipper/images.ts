import remarkParse from 'remark-parse'
import { unified } from 'unified'

interface ImageLink {
  url: string
  start: number
  end: number
}

function remoteImages(markdown: string): ImageLink[] {
  const images: ImageLink[] = []
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
  return images
}

export function hasRemoteImages(markdown: string): boolean {
  return remoteImages(markdown).length > 0
}

export async function storeImageLinks(
  markdown: string,
  upload: (url: string) => Promise<string>,
  progress: (done: number, total: number) => void = () => {},
): Promise<string> {
  const images = remoteImages(markdown)
  const stored = new Map<string, string>()
  const urls = [...new Set(images.map((image) => image.url))].slice(0, 50)
  if (urls.length) progress(0, urls.length)
  for (const [index, url] of urls.entries()) {
    try {
      stored.set(url, await upload(url))
    } catch {
      /* A refused image stays remote. */
    }
    progress(index + 1, urls.length)
  }
  for (const image of images.reverse()) {
    const url = stored.get(image.url)
    if (url) markdown = markdown.slice(0, image.start) + url + markdown.slice(image.end)
  }
  return markdown
}
