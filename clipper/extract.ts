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
  }
  return parts.join(' - ').trim() || title.trim()
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
  const article = mode === 'article' ? new Readability(page).parse() : null
  if (mode === 'article' && !article) throw new Error('E_CLIP_EMPTY')
  const body = htmlToMarkdown(article?.content ?? page.body.innerHTML).markdown.trim()
  if (!body) throw new Error('E_CLIP_EMPTY')
  const markdown = `${body}\n\n${cleanUrl(url)}\n`
  checkMarkdown(markdown)
  const ogTitle = source.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim()
  const site =
    source.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim() ||
    article?.siteName ||
    ''
  return { title: cleanTitle(ogTitle || article?.title || source.title, site), markdown }
}
