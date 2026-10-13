// A fenced code block's title, from its info string: ```js title="app.js",
// ```js app.js (the rest of the line, when it sets nothing) or ```js:app.js.
// The title travels as the code element's `data-title`, which the preview
// shows in the block's header with the language's mark.
import type { Code, Root } from 'mdast'

/** The longest title kept; a longer one is cut. */
export const MAX_CODE_TITLE_CHARS = 200

const TITLE_SETTING = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/

/** The title an info string's language and meta give, if any. */
export function codeTitle(lang: string | null | undefined, meta: string | null | undefined) {
  const fromMeta = (() => {
    const text = (meta ?? '').trim()
    if (text === '') return ''
    const set = TITLE_SETTING.exec(text)
    if (set) return (set[1] ?? set[2] ?? set[3] ?? '').trim()
    return text.includes('=') ? '' : text
  })()
  const colon = (lang ?? '').indexOf(':')
  const fromLang = colon > 0 ? (lang ?? '').slice(colon + 1).trim() : ''
  const title = fromMeta || fromLang
  return {
    lang: colon > 0 ? (lang ?? '').slice(0, colon) : (lang ?? null),
    title: title.slice(0, MAX_CODE_TITLE_CHARS),
  }
}

function visit(node: Root | Root['children'][number]): void {
  if (node.type === 'code') {
    const code = node as Code
    const { lang, title } = codeTitle(code.lang, code.meta)
    code.lang = lang
    if (title !== '') {
      const data = (code.data ??= {})
      data.hProperties = { ...(data.hProperties ?? {}), dataTitle: title }
    }
    return
  }
  if ('children' in node) node.children.forEach(visit)
}

/** The remark plugin: titles on code blocks, before they become HTML. */
export function remarkCodeTitle() {
  return (tree: Root) => visit(tree)
}
