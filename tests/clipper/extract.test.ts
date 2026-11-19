// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { extract } from '../../clipper/extract'

const url = 'https://example.org/news/story'
const prose =
  'A detailed account of the expedition, with observations from the research team and the people who live here. '.repeat(
    12,
  )

it('removes heading controls without removing ordinary edit links', () => {
  document.head.innerHTML = ''
  document.body.innerHTML = `<article><h1>Expedition</h1><p>${prose}</p><div><a href="/edit">[edit]</a><h2>History<span class="mw-editsection"><a href="/edit">[edit]</a></span><button>Change</button><span role="button">Collapse</span><span aria-hidden="true">Hidden</span></h2><a href="/edit">[edit]</a></div><h3>Details <a href="/edit">edit</a></h3><p>${prose}<a href="/edit">edit</a></p></article>`
  const result = extract(document, url, 'article')
  expect(result.markdown).toContain('## History')
  expect(result.markdown).toContain('### Details')
  expect(result.markdown).not.toMatch(/Change|Collapse|Hidden/)
  expect(result.markdown.match(/\[edit\]\(https:\/\/example.org\/edit\)/g)).toHaveLength(1)
})

it.each([
  ['Lighthouse - Wikipedia', '', 'Wikipedia', 'Lighthouse'],
  ['Wikipedia — Lighthouse', '', 'Wikipedia', 'Lighthouse'],
  ['Lighthouse | Site', '', '', 'Lighthouse'],
  ['Lighthouse — Site', '', '', 'Lighthouse'],
  ['Browser title', 'Article headline', 'Site', 'Article headline'],
  ['Lighthouse', '', '', 'Lighthouse'],
])('chooses a clean article title from %s', (title, og, site, expected) => {
  document.head.innerHTML = `<title>${title}</title><meta property="og:title" content="${og}"><meta property="og:site_name" content="${site}">`
  document.body.innerHTML = `<article><h1>${title}</h1><p>${prose}</p></article>`
  expect(extract(document, url, 'article').title).toBe(expected)
})

it('removes tracking parameters while preserving meaningful image and link parameters', () => {
  document.head.innerHTML = ''
  document.body.innerHTML = `<article><h1>Expedition</h1><p>${prose}</p><img src="/photo.png?width=500&utm_source=x&fbclid=x" alt="Photo"><a href="/more?gclid=x&page=2&mc_eid=x">More</a></article>`
  const result = extract(document, url, 'article')
  expect(result.markdown).toContain('![Photo](https://example.org/photo.png?width=500)')
  expect(result.markdown).toContain('[More](https://example.org/more?page=2)')
  expect(result.markdown).not.toMatch(/utm_|fbclid|gclid|mc_eid/)
})

it('extracts an article, preserving Markdown structure and absolute lazy images', () => {
  document.body.innerHTML = `<nav>Navigation junk</nav><article><h1>Expedition</h1><p>${prose}</p><h2>Findings</h2><p>${prose}</p><ul><li>First finding</li></ul><pre><code>const answer = 42;</code></pre><img data-src="../photo.jpg" alt="Team"><picture><source srcset="/wide.jpg 2x"><img alt="Landscape"></picture><img src="javascript:bad"><a href="/more">More</a></article><aside class="ad">Advertisement junk</aside><footer>Footer junk</footer>`
  const result = extract(document, url, 'article')
  expect(result.markdown).toContain('## Findings')
  expect(result.markdown).toContain('- First finding')
  expect(result.markdown).toContain('const answer = 42;')
  expect(result.markdown).toContain('![Team](https://example.org/photo.jpg)')
  expect(result.markdown).toContain('![Landscape](https://example.org/wide.jpg)')
  expect(result.markdown).toContain('[More](https://example.org/more)')
  expect(result.markdown).not.toMatch(/Navigation junk|Footer junk|Advertisement junk|javascript:/)
  expect(result.markdown.endsWith(`\n\n${url}\n`)).toBe(true)
  expect(document.querySelector('img')?.getAttribute('data-src')).toBe('../photo.jpg')
})

it('converts selected HTML only', () => {
  document.body.innerHTML =
    '<p>Outside</p><section><h2>Selected</h2><p>Chosen <strong>words</strong></p><img src="/image.png" alt="Selected image"></section>'
  const range = document.createRange()
  range.selectNodeContents(document.querySelector('section')!)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
  const result = extract(document, url, 'selection')
  expect(result.markdown).toContain('Chosen **words**')
  expect(result.markdown).toContain('![Selected image](https://example.org/image.png)')
  expect(result.markdown).not.toContain('Outside')
})

it('refuses an empty selection and a non-web source', () => {
  document.getSelection()!.removeAllRanges()
  expect(() => extract(document, url, 'selection')).toThrow('E_CLIP_EMPTY')
  expect(() => extract(document, 'file:///private', 'article')).toThrow('E_CLIP_URL')
})

it.each(['srcset', 'data-srcset'])(
  'does not turn inline %s payloads into relative image URLs',
  (attribute) => {
    document.head.innerHTML = ''
    document.body.innerHTML = `<article><h1>Expedition</h1><p>${prose}</p><img ${attribute}="data:image/png;base64,aGVsbG8= 2x"><img ${attribute}="/real.png 1x, data:image/png;base64,aGVsbG8= 2x" alt="Real"><img ${attribute}="data:image/png;base64,aGVsbG8= 1x, /other.png 2x" alt="Other"></article>`
    const result = extract(document, url, 'article')
    expect(result.markdown).not.toMatch(/aGVsbG8|data:image/)
    expect(result.markdown).toContain('![Real](https://example.org/real.png)')
    expect(result.markdown).toContain('![Other](https://example.org/other.png)')
  },
)
