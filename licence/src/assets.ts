import { COLORS, type ColorToken, DOVE } from './brand.ts'

export const ASSETS = {
  style: '/assets/licence.css',
  copy: '/assets/copy.js',
} as const

const vars = (theme: Record<ColorToken, string>) =>
  Object.entries(theme)
    .map(([name, value]) => `--color-${name}:${value};`)
    .join('')

const inks = (stops: readonly string[]) =>
  stops.map((color, i) => `.ink-${i}{stop-color:${color}}`).join('')

// The page is built from the system theme's tokens (brand.ts); the button fill in dark is
// deepened toward the window colour so white text keeps AA, as on devot.online.
const STYLE = `
:root{color-scheme:light dark;${vars(COLORS.light)}--brand:var(--color-activity-level-4);--brand-fill:var(--brand);--brand-fill-hover:color-mix(in oklab,var(--brand) 84%,var(--color-text-primary));--font-ui:-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--font-display:ui-serif,'New York',Georgia,serif}
@media (prefers-color-scheme:dark){:root{${vars(COLORS.dark)}--brand-fill:color-mix(in oklab,var(--brand) 62%,var(--color-surface-window));--brand-fill-hover:color-mix(in oklab,var(--brand) 68%,var(--color-surface-window))}${inks(DOVE.ink.dark)}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{display:flex;flex-direction:column;min-height:100dvh;margin:0;padding:0 clamp(1.25rem,5vw,2.5rem);background:var(--color-surface-editor);color:var(--color-text-primary);font:400 1.0625rem/1.55 var(--font-ui);-webkit-font-smoothing:antialiased}
a{color:var(--color-accent-text);text-underline-offset:.2em}
:focus-visible{outline:2px solid var(--color-focus-ring);outline-offset:3px}
.bar,main,.foot{width:100%;max-width:36rem;margin:0 auto}
.bar{padding:1.5rem 0}
.brand{display:inline-flex;align-items:center;gap:.5rem;color:var(--color-text-primary);font-size:1.125rem;font-weight:600;letter-spacing:-.01em;text-decoration:none}
.brand svg{width:1.75rem;height:auto}
main{flex:1;padding:clamp(1.5rem,6vh,4rem) 0 3rem}
h1{margin:0 0 .75rem;font:330 clamp(2rem,1.4rem + 2.4vw,2.75rem)/1.08 var(--font-display);letter-spacing:-.014em;text-wrap:balance}
h2{margin:2rem 0 .25rem;font-size:1.0625rem;font-weight:600;letter-spacing:-.01em}
p{margin:0 0 1rem}
.lead{color:var(--color-text-secondary);font-size:clamp(1.0625rem,1rem + .3vw,1.1875rem);text-wrap:pretty}
.muted{color:var(--color-text-secondary)}
.label{margin:1.75rem 0 .5rem;color:var(--color-text-secondary);font-size:.75rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.key{margin:0;padding:1rem 1.125rem;border:1px solid var(--color-line-separator);border-radius:12px;background:var(--color-fill-card);font:400 .9375rem/1.5 var(--font-mono);overflow-wrap:anywhere;word-break:break-all;white-space:pre-wrap;-webkit-user-select:all;user-select:all}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem;margin:1.25rem 0 1.5rem}
.button{display:inline-flex;flex:0 1 auto;align-items:center;justify-content:center;min-height:3rem;padding:0 1.375rem;border:1px solid transparent;border-radius:999px;background:var(--color-fill-button);color:var(--color-text-primary);font:600 1.0625rem/1.2 var(--font-ui);text-decoration:none;cursor:pointer;transition:background-color .18s cubic-bezier(0,0,.58,1)}
.button[hidden]{display:none}
.primary{background:var(--brand-fill);color:var(--color-accent-on-fill)}
.primary:hover{background:var(--brand-fill-hover)}
.status{min-height:1.55em;margin:0;color:var(--color-text-secondary);font-size:.875rem}
.form{display:flex;flex-wrap:wrap;gap:.75rem;margin:1.5rem 0}
.form label{flex-basis:100%;font-weight:600;font-size:.9375rem}
.form input{flex:1 1 14rem;min-width:0;min-height:3rem;padding:0 1rem;border:1px solid var(--color-line-control);border-radius:12px;background:var(--color-fill-field);color:var(--color-text-primary);font:inherit}
.code{color:var(--color-text-secondary);font-size:.875rem}
.devices{list-style:none;margin:1.5rem 0;padding:0;display:grid;gap:.75rem}
.devices li{display:grid;gap:.25rem;padding:1rem 1.125rem;border:1px solid var(--color-line-separator);border-radius:12px;background:var(--color-fill-card)}
.devices .muted{font-size:.875rem;overflow-wrap:anywhere}
.devices form{margin:.5rem 0 0}
.devices .button{min-height:2.5rem;padding:0 1rem;font-size:.9375rem}
.code code{font-family:var(--font-mono)}
.wait{display:flex;align-items:center;gap:.75rem}
.spinner{flex:none;width:1.25rem;height:1.25rem;border:2px solid var(--color-line-control);border-top-color:var(--brand);border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion:reduce){.spinner{animation:none}.button{transition:none}}
.foot{padding:1.5rem 0 2rem;border-top:1px solid var(--color-line-separator);color:var(--color-text-secondary);font-size:.875rem}
.foot a{color:inherit}
@media (max-width:30rem){.actions .button,.form .button{flex:1 1 100%}}
`.trim()

// Shows the Copy button only where the clipboard works; its labels come from the page.
const COPY = `
for (const button of document.querySelectorAll('[data-copy]')) {
  const source = document.getElementById(button.dataset.copy)
  const status = document.getElementById(button.dataset.status)
  if (!source || !status || !navigator.clipboard) continue
  button.hidden = false
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(source.textContent.trim())
      status.textContent = button.dataset.copied
    } catch {
      status.textContent = button.dataset.failed
    }
  })
}
`.trim()

const FILES: Record<string, { body: string; type: string }> = {
  [ASSETS.style]: { body: STYLE, type: 'text/css; charset=utf-8' },
  [ASSETS.copy]: { body: COPY, type: 'text/javascript; charset=utf-8' },
}

/** The stylesheet or script at `pathname`, or undefined when it is not one. */
export function assetResponse(pathname: string, method: string): Response | undefined {
  const file = Object.hasOwn(FILES, pathname) ? FILES[pathname] : undefined
  if (!file || (method !== 'GET' && method !== 'HEAD')) return undefined
  return new Response(method === 'HEAD' ? null : file.body, {
    headers: {
      'Content-Type': file.type,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  })
}
