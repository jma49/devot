import { renderToString } from '@plantuml/core'
import type { RenderRequest } from '../preview/mermaid-protocol'
import { registerEngine } from './registry'

async function drawing(request: RenderRequest): Promise<string> {
  await import('@plantuml/core/themes.js')
  Object.assign(globalThis, {
    PLANTUML_STDLIB_LOADER: (_name: string, _ok: () => void, fail: (reason: string) => void) => {
      fail('E_DIAGRAM_INCLUDE')
      return true
    },
  })
  // No host loaders: includes must never turn note content into a network request.
  if (/^\s*!(?:include\w*|import)\b/im.test(request.source)) throw new Error('E_DIAGRAM_INCLUDE')
  const markup = await new Promise<string>((resolve, reject) => {
    renderToString(
      request.source.split(/\r?\n/),
      resolve,
      () => reject(new Error('E_DIAGRAM_SOURCE')),
      {
        dark: request.appearance === 'dark',
        maxSvgSize: 8192,
      },
    )
  })
  // An inert template avoids applying SVG style attributes under the parent's strict CSP.
  const template = document.createElement('template')
  template.innerHTML = markup
  const svg = template.content.querySelector('svg')
  if (!svg) throw new Error('E_DIAGRAM_SVG')
  for (const element of svg.querySelectorAll('[style]')) {
    element.removeAttribute('style')
    if (element.localName === 'text')
      element.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
  }
  svg.removeAttribute('style')
  return new XMLSerializer().serializeToString(svg)
}

registerEngine('plantuml', (request) =>
  drawing(request).then(
    (svg) => ({ type: 'rendered', svg }),
    () => ({ type: 'failed', reason: 'parse' }),
  ),
)
