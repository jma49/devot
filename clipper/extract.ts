import { Readability } from '@mozilla/readability'
import { htmlToMarkdown } from '../src/core/htmlImport'
import { checkMarkdown } from './client'

export type Mode = 'article' | 'selection'
export interface Clip {
  title: string
  markdown: string
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
  const absolute = (value: string | null): string | null => {
    if (!value?.trim()) return null
    try {
      const resolved = new URL(value, base)
      return ['http:', 'https:'].includes(resolved.protocol) ? resolved.href : null
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
      absolute(set?.split(',').at(-1)?.trim().split(/\s+/)[0] ?? null) ||
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
  const markdown = `${body}\n\n${url.href}\n`
  checkMarkdown(markdown)
  return { title: article?.title || source.title, markdown }
}
