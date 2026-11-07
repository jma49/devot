// Apart from frontMatter.ts so the main window finds the fence without loading the Markdown parser.
const CLOSE = /(?:\r\n?|\n)---[ \t]*(?=\r\n?|\n|(?![\s\S]))/g

/** The front matter fence and what it holds, so a long note is not parsed whole to find it. */
export function frontMatterHead(markdown: string): string | null {
  if (!/^---[ \t]*(?:\r\n?|\n)/.test(markdown)) return null
  CLOSE.lastIndex = 3
  return CLOSE.exec(markdown) ? markdown.slice(0, CLOSE.lastIndex) : null
}
