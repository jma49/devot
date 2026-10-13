import type { Element, Root, RootContent } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { describe, expect, it } from 'vitest'
import { pageBody, renderPreview, type PreviewLabels } from '../../src/core'

// Known XSS payloads, as they could arrive through import, sync or AI. Each
// must come out of the preview pipeline inert.
const CORPUS = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=https://evil.example/x.js></SCRIPT>',
  '<img src=x onerror=alert(1)>',
  '<img src="javascript:alert(1)">',
  '<svg onload=alert(1)><circle r=1></circle></svg>',
  '<svg><script>alert(1)</script></svg>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="  javascript:alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '[x](javascript:alert(1))',
  '[x](<javascript:alert(1)>)',
  '![x](javascript:alert(1))',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<iframe src="https://evil.example" onload="alert(1)"></iframe>',
  '<object data="https://evil.example/x.swf"></object>',
  '<embed src="https://evil.example/x.swf">',
  '<form action="https://evil.example"><input name=q><button>go</button></form>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<base href="https://evil.example/">',
  '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<style>body{background:url(https://evil.example/x)}</style>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<p onclick="alert(1)" onmouseover="alert(1)">x</p>',
  '<details open ontoggle=alert(1)><summary>s</summary></details>',
  '<video><source onerror=alert(1)></video>',
  '<input autofocus onfocus=alert(1)>',
  '<body onload=alert(1)>',
  '<a id="x" name="cookie">clobber</a>',
  '<img src=x:alert(1) onerror=eval(src)>',
  '<!--<img src="--><img src=x onerror=alert(1)//">',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<template><script>alert(1)</script></template>',
  '<x onclick=alert(1)>custom</x>',
  '$\\href{javascript:alert(1)}{x}$',
  '$\\url{javascript:alert(1)}$',
  '$$\\htmlStyle{background:url(https://evil.example)}{x}$$',
  '$\\class{x}{y} \\htmlId{z}{w} \\htmlData{a=b}{c}$',
  '```math\n\\href{javascript:alert(1)}{x}\n```',
  '![x](javascript:alert(1)#small)',
  '<img src="javascript:alert(1)#half" class="image-size-full">',
  '![x](devot://file/../../etc#full)',
]

const labels: PreviewLabels = {
  alerts: {
    note: 'Note',
    tip: 'Tip',
    important: 'Important',
    warning: 'Warning',
    caution: 'Caution',
  },
  embedFrom: 'Embedded content from {origin}',
  embedLoad: 'Load',
  videoTitle: 'Embedded video',
  untitled: 'Untitled',
  missingNote: 'Note not found',
}

const FORBIDDEN_TAGS = new Set([
  'script',
  'style',
  'object',
  'embed',
  'form',
  'meta',
  'base',
  'link',
  'svg',
  'math',
  'template',
  'noscript',
  'body',
  'video',
])
// Allowed schemes, fragments, or relative URLs (no scheme at all).
const SAFE_URL = /^(?:https?:|mailto:|devot:\/\/(?:note|file)\/[0-9a-f-]{36}$|#|[^:]*$)/i

function problems(node: Root | RootContent, path = 'root'): string[] {
  if (node.type === 'comment') return [`${path}: comment`]
  if (node.type === 'raw') return [`${path}: raw HTML`]
  if (node.type !== 'element' && node.type !== 'root') return []
  const found: string[] = []
  if (node.type === 'element') {
    const el: Element = node
    if (FORBIDDEN_TAGS.has(el.tagName)) found.push(`${path}: <${el.tagName}>`)
    for (const [key, value] of Object.entries(el.properties)) {
      if (/^on/i.test(key)) found.push(`${path}: handler ${key}`)
      if (key === 'style' || key === 'srcDoc') found.push(`${path}: ${key}`)
      if (['href', 'src', 'action', 'formAction', 'data', 'xLinkHref'].includes(key)) {
        if (typeof value !== 'string' || !SAFE_URL.test(value)) {
          found.push(`${path}: ${key}=${String(value)}`)
        }
      }
      if (key === 'id' || key === 'name') {
        if (!String(value).startsWith('user-content-'))
          found.push(`${path}: ${key}=${String(value)}`)
      }
    }
    if (el.tagName === 'iframe') {
      const sandbox = el.properties['sandbox']
      if (!Array.isArray(sandbox) || sandbox.includes('allow-top-navigation')) {
        found.push(`${path}: iframe sandbox`)
      }
      if (!String(el.properties['src']).startsWith('https:')) found.push(`${path}: iframe src`)
    }
  }
  node.children.forEach((child, i) => found.push(...problems(child, `${path}/${i}`)))
  return found
}

describe('preview sanitizer', () => {
  it.each(CORPUS)('neutralises %s', async (payload) => {
    const tree = await renderPreview(payload, { labels, loadedEmbeds: [] })
    expect(problems(tree)).toEqual([])
  })

  it('stays inert even when the user loads an unknown embed', async () => {
    const tree = await renderPreview('<iframe src="https://evil.example" sandbox=""></iframe>', {
      labels,
      loadedEmbeds: ['https://evil.example'],
    })
    expect(problems(tree)).toEqual([])
  })
})

// Exported pages (HTML export, Copy as HTML, printing) are opened outside
// Devot, without its CSP: they must hold no script, handler or frame either.
describe('exported pages', () => {
  const NONCE = '0123456789abcdef0123456789abcdef'

  it.each(CORPUS)('stay inert for %s', async (payload) => {
    const tree = await renderPreview(payload, { labels, loadedEmbeds: ['https://evil.example'] })
    for (const simple of [false, true]) {
      // Read back as a browser would.
      const page = fromHtml(pageBody(tree, { nonce: NONCE, simple }).html, { fragment: true })
      expect(problems(page)).toEqual([])
      expect(pageBody(tree, { nonce: NONCE, simple }).html).not.toMatch(/<(?:iframe|button)\b/)
    }
  })
})
