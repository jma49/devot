import { Readability } from '@mozilla/readability'
import { htmlToMarkdown } from '../src/core/htmlImport'
import { checkMarkdown } from './client'

export type Mode = 'article' | 'selection'
export interface Clip {
  title: string
  markdown: string
}

function cleanUrl(url: URL): string {
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid)$/i.test(key))
      url.searchParams.delete(key)
  }
  return url.href
}

function cleanTitle(title: string, site: string): string {
  const parts = title.trim().split(/\s+[-–—|]\s+/)
  if (parts.length > 1) {
    if (site && parts[0]?.toLowerCase() === site.toLowerCase()) parts.shift()
    else if (site && parts.at(-1)?.toLowerCase() === site.toLowerCase()) parts.pop()
    else parts.pop()
    // "Title - Section - Site": a short section label left behind the site goes too.
    const last = parts.at(-1) ?? ''
    if (parts.length > 1 && last.split(/\s+/).length <= 2 && last.length <= 20) parts.pop()
  }
  return parts.join(' - ').trim() || title.trim()
}

const LANGUAGE = /(?:^|\s)(?:language|lang|highlight-source|brush:?)-?\s*([\w+#-]+)/i

/** Shapes page markup the Markdown writer would otherwise turn into noise. */
function tidy(page: Document, pageUrl: string): void {
  const here = pageUrl.replace(/#.*$/, '')
  const samePage = (link: Element) => {
    const href = link.getAttribute('href') ?? ''
    return href.startsWith('#') || (href.includes('#') && href.replace(/#.*$/, '') === here)
  }
  const unwrap = (element: Element) => element.replaceWith(...element.childNodes)
  // A footnote marker such as [1] stays as text: the reference list it points to is clipped too, but its link would lead nowhere in a note.
  for (const link of page.querySelectorAll('a[href]'))
    if (samePage(link) && /^\[?\s*(\d+|[a-z])\s*\]?$/i.test(link.textContent?.trim() ?? ''))
      unwrap(link)
  for (const anchor of page.querySelectorAll('a:not([href])')) unwrap(anchor)
  // A heading's permalink.
  for (const link of page.querySelectorAll(':is(h1,h2,h3,h4,h5,h6) a[href]'))
    if (samePage(link)) unwrap(link)
  // An image linked to its own file page or full-size copy reads better as the image.
  for (const link of page.querySelectorAll('a')) {
    const images = link.querySelectorAll('img')
    if (images.length === 1 && !link.textContent?.trim()) unwrap(link)
  }
  // A figure's caption goes under its image, and names an image that has no description.
  for (const figure of page.querySelectorAll('figure')) {
    const caption = figure.querySelector('figcaption')
    const text = caption?.textContent?.replace(/\s+/g, ' ').trim()
    if (!caption || !text) continue
    const image = figure.querySelector('img')
    if (image && !image.getAttribute('alt')?.trim()) image.setAttribute('alt', text)
    const paragraph = page.createElement('p')
    const emphasis = page.createElement('em')
    emphasis.append(...caption.childNodes)
    paragraph.append(emphasis)
    caption.replaceWith(paragraph)
    if (image) {
      const holder = page.createElement('p')
      holder.append(image)
      paragraph.before(holder)
    }
  }
  // Code blocks keep their language, which pages state in many ways.
  for (const pre of page.querySelectorAll('pre')) {
    const named = [
      pre,
      pre.querySelector('code'),
      pre.parentElement,
      pre.parentElement?.parentElement,
    ]
      .map(
        (element) =>
          element?.getAttribute('lang') ||
          element?.getAttribute('data-lang') ||
          LANGUAGE.exec(element?.className ?? '')?.[1],
      )
      .find(Boolean)
    let code = pre.querySelector('code')
    if (!code) {
      code = page.createElement('code')
      code.append(...pre.childNodes)
      pre.append(code)
    }
    if (!named) continue
    code.className = `language-${named.toLowerCase()}`
    const label = pre.previousElementSibling
    if (
      label?.matches('div,span,p') &&
      !label.matches('[role="heading"]') &&
      !label.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]') &&
      label.textContent?.trim().toLowerCase() === named.toLowerCase()
    )
      label.remove()
  }
}

/** Copies what an empty component draws in its open shadow root into the clone: only its code blocks when it has any, leaving out toolbars around them. */
function showComponents(source: Document, page: Document): void {
  const originals = source.body.querySelectorAll('*')
  const copies = page.body.querySelectorAll('*')
  originals.forEach((element, index) => {
    const copy = copies[index]
    if (!element.shadowRoot || !copy || element.childNodes.length) return
    const blocks = [...element.shadowRoot.querySelectorAll('pre')]
    const drawn = blocks.length
      ? blocks
      : [...element.shadowRoot.children].filter(
          (node) => !node.matches('style, script, link, slot'),
        )
    for (const node of drawn) copy.append(node.cloneNode(true))
  })
}

function srcsetUrls(value: string): string[] {
  const urls: string[] = []
  let rest = value
  while (rest) {
    rest = rest.replace(/^[\s,]+/, '')
    const token = /^\S+/.exec(rest)?.[0]
    if (!token) break
    urls.push(token.replace(/,+$/, ''))
    rest = rest.slice(token.length)
    if (token.endsWith(',')) continue
    let parentheses = 0
    let end = 0
    for (; end < rest.length; end++) {
      const char = rest[end]
      if (char === '(') parentheses++
      else if (char === ')') parentheses = Math.max(0, parentheses - 1)
      else if (char === ',' && parentheses === 0) break
    }
    rest = rest.slice(end + 1)
  }
  return urls
}

export function extract(source: Document, sourceUrl: string, mode: Mode): Clip {
  const url = new URL(sourceUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('E_CLIP_URL')
  const page = source.cloneNode(true) as Document
  showComponents(source, page)
  const base = new URL(
    source.querySelector('base[href]')?.getAttribute('href') || sourceUrl,
    sourceUrl,
  )
  if (mode === 'selection') {
    const selection = source.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount)
      throw new Error('E_CLIP_EMPTY')
    page.body.replaceChildren()
    for (let i = 0; i < selection.rangeCount; i++)
      page.body.append(selection.getRangeAt(i).cloneContents())
  }
  const headings = 'h1,h2,h3,h4,h5,h6'
  for (const control of page.querySelectorAll(
    '.mw-editsection,button,[role="button"],[aria-hidden="true"]',
  ))
    control.remove()
  for (const link of page.querySelectorAll('a')) {
    if (!/^\[?\s*edit\s*\]?$/i.test(link.textContent?.trim() ?? '')) continue
    if (
      link.closest(headings) ||
      link.previousElementSibling?.matches(headings) ||
      link.nextElementSibling?.matches(headings) ||
      (/^\[?\s*edit\s*\]?$/i.test(link.parentElement?.textContent?.trim() ?? '') &&
        (link.parentElement?.previousElementSibling?.matches(headings) ||
          link.parentElement?.nextElementSibling?.matches(headings)))
    )
      link.remove()
  }
  const absolute = (value: string | null): string | null => {
    if (!value?.trim()) return null
    try {
      const resolved = new URL(value, base)
      return ['http:', 'https:'].includes(resolved.protocol) ? cleanUrl(resolved) : null
    } catch {
      return null
    }
  }
  for (const image of page.querySelectorAll('img')) {
    const set =
      image.getAttribute('data-srcset') ||
      image.getAttribute('srcset') ||
      image.closest('picture')?.querySelector('source')?.getAttribute('srcset')
    const src =
      absolute(image.getAttribute('data-src')) ||
      srcsetUrls(set ?? '')
        .map(absolute)
        .filter(Boolean)
        .at(-1) ||
      absolute(image.getAttribute('src'))
    if (!src) {
      image.remove()
      continue
    }
    image.setAttribute('src', src)
    image.removeAttribute('data-src')
    image.removeAttribute('srcset')
  }
  for (const link of page.querySelectorAll('a[href]')) {
    const href = absolute(link.getAttribute('href'))
    if (href) link.setAttribute('href', href)
    else link.removeAttribute('href')
  }
  tidy(page, url.href)
  const article = mode === 'article' ? new Readability(page, { keepClasses: true }).parse() : null
  if (mode === 'article' && !article) throw new Error('E_CLIP_EMPTY')
  const body = htmlToMarkdown(article?.content ?? page.body.innerHTML).markdown.trim()
  if (!body) throw new Error('E_CLIP_EMPTY')
  const markdown = `${body}\n\n${cleanUrl(url)}\n`
  checkMarkdown(markdown)
  return { title: pageTitle(source, article), markdown }
}

export function pageTitle(
  source: Document,
  article?: {
    title?: string | null | undefined
    siteName?: string | null | undefined
  } | null,
): string {
  const ogTitle = source.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim()
  const site =
    source.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim() ||
    article?.siteName ||
    ''
  return cleanTitle(ogTitle || article?.title || source.title, site)
}
