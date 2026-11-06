// A diagram's CSS can come from its note (a directive's themeCSS, classDef, style), so nothing
// in it may make the page fetch: no URL but a same-document fragment, no image function, no import.
const FETCHES = /url\((?![\s'"]*#)|image-set\(|(?:^|[^\w-])(?:image|src)\(|@import/i
/** Every form FETCHES finds has one of these, escapes included; the rest of a drawing skips the full check. */
const MAY_FETCH = /[(@\\]/

type Item = string | { prelude: string; body: Item[] }

/** Escapes decoded as CSS reads them, so `\75 rl(` is seen as `url(`. */
function unescaped(text: string): string {
  return text.replace(/\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([\s\S]))/gi, (_, hex, char) => {
    if (!hex) return char as string
    const code = Number.parseInt(hex as string, 16)
    return String.fromCodePoint(code === 0 || code > 0x10ffff ? 0xfffd : code)
  })
}

export function pointsElsewhere(text: string): boolean {
  return MAY_FETCH.test(text) && FETCHES.test(unescaped(text))
}

function stringEnd(css: string, from: number): number {
  const quote = css[from]
  for (let i = from + 1; i < css.length; i += 1) {
    if (css[i] === '\\') i += 1
    else if (css[i] === quote) return i + 1
    else if (css[i] === '\n') return i
  }
  return css.length
}

function parse(css: string): Item[] {
  let i = 0
  const block = (nested: boolean): Item[] => {
    const items: Item[] = []
    let start = i
    let depth = 0
    while (i < css.length) {
      const c = css[i]
      if (c === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2)
        i = end < 0 ? css.length : end + 2
        continue
      }
      if (c === '"' || c === "'") {
        i = stringEnd(css, i)
        continue
      }
      if (c === '\\') i += 1
      else if (c === '(') depth += 1
      else if (c === ')') depth = Math.max(0, depth - 1)
      else if (depth === 0 && c === ';') {
        items.push(css.slice(start, i + 1))
        start = i + 1
      } else if (depth === 0 && c === '{') {
        const prelude = css.slice(start, i)
        i += 1
        items.push({ prelude, body: block(true) })
        start = i
        continue
      } else if (depth === 0 && c === '}') {
        if (start < i) items.push(css.slice(start, i))
        i += 1
        if (nested) return items
        start = i
        continue
      }
      i += 1
    }
    if (start < css.length) items.push(css.slice(start))
    return items
  }
  return block(false)
}

function print(items: Item[]): string {
  return items
    .map((item) => {
      if (typeof item === 'string') return pointsElsewhere(item) ? '' : item
      return pointsElsewhere(item.prelude) ? '' : `${item.prelude}{${print(item.body)}}`
    })
    .join('')
}

/** A stylesheet or declaration list without the declarations and rules that would fetch. */
export function withoutRemoteCss(css: string): string {
  return pointsElsewhere(css) ? print(parse(css)) : css
}
