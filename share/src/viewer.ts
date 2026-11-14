import { COLORS } from '../../licence/src/brand.ts'
import { openEnvelope } from './envelope.ts'
import { MESSAGES } from './messages.ts'

export const VIEWER_ASSETS = {
  style: '/assets/viewer.css',
  script: '/assets/viewer.js',
} as const

export const VIEWER_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const vars = (theme: Record<string, string>) =>
  Object.entries(theme)
    .map(([name, value]) => `--color-${name}:${value};`)
    .join('')

export const VIEWER_STYLE = `
:root{color-scheme:light dark;${vars(COLORS.light)}--font-ui:-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{${vars(COLORS.dark)}}}
*,*::before,*::after{box-sizing:border-box}
body{display:flex;flex-direction:column;min-height:100dvh;margin:0;background:var(--color-surface-editor);color:var(--color-text-primary);font:400 1rem/1.5 var(--font-ui);-webkit-font-smoothing:antialiased}
main{flex:1;width:100%}
.status{max-width:36rem;margin:0 auto;padding:clamp(2rem,10vh,6rem) 1.25rem;color:var(--color-text-secondary)}
.status[hidden],iframe[hidden]{display:none}
iframe{display:block;width:100%;min-height:60vh;border:0;background:var(--color-surface-editor)}
footer{padding:1.5rem 1.25rem;border-top:1px solid var(--color-line-separator);color:var(--color-text-secondary);font-size:.8125rem;text-align:center}
a{color:inherit;text-underline-offset:.2em}
:focus-visible{outline:2px solid var(--color-focus-ring);outline-offset:3px}
`

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function viewerPage(id: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(MESSAGES.title)}</title>
<link rel="stylesheet" href="${VIEWER_ASSETS.style}">
<script src="${VIEWER_ASSETS.script}" defer></script>
</head>
<body data-share="${escape(id)}">
<main>
<p class="status" role="status" aria-live="polite">${escape(MESSAGES.opening)}</p>
<iframe hidden title="${escape(MESSAGES.frame)}" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>
</main>
<footer>${escape(MESSAGES.footer)} <a href="https://devot.online/">${escape(MESSAGES.home)}</a></footer>
</body>
</html>
`
}

/** The page's script: the envelope opener as written in envelope.ts, then the steps around it. */
export const VIEWER_SCRIPT = `'use strict'
;(() => {
const MESSAGES = ${JSON.stringify(MESSAGES)}
${openEnvelope.toString()}
const status = document.querySelector('.status')
const frame = document.querySelector('iframe')
const say = (key) => {
  status.textContent = MESSAGES[key]
  status.hidden = false
  frame.hidden = true
}
const fit = () => {
  const doc = frame.contentDocument
  if (doc && doc.documentElement) frame.style.height = doc.documentElement.scrollHeight + 'px'
}
const show = (page) => {
  document.title = page.title || MESSAGES.title
  const base = '<base target="_blank">'
  frame.srcdoc = /<head[^>]*>/i.test(page.html)
    ? page.html.replace(/<head[^>]*>/i, (head) => head + base)
    : base + page.html
  frame.addEventListener('load', () => {
    fit()
    if (frame.contentDocument && 'ResizeObserver' in window) {
      new ResizeObserver(fit).observe(frame.contentDocument.documentElement)
    }
  })
  status.hidden = true
  frame.hidden = false
}
const open = async () => {
  const key = location.hash.slice(1)
  if (!key) return say('missingKey')
  const id = document.body.dataset.share
  let response
  try {
    response = await fetch('/v1/shares/' + id, { cache: 'no-store', credentials: 'omit' })
  } catch {
    return say('broken')
  }
  if (response.status === 404) return say('gone')
  if (!response.ok) return say('broken')
  const page = await openEnvelope(new Uint8Array(await response.arrayBuffer()), key)
  if (!page) return say('broken')
  show(page)
}
void open()
})()
`
