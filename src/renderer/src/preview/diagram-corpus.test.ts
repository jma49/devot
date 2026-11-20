// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import corpus from '../../../../tests/fixtures/diagram-svg.json'
import sources from '../../../../tests/fixtures/diagram-corpus.json'
import { pageBody } from '../../../core/htmlExport'
import { importSvg } from './mermaid'

vi.hoisted(() => {
  document.insertBefore(
    document.implementation.createDocumentType('html', '', ''),
    document.documentElement,
  )
})

it('records every source in the diagram corpus', () => {
  expect(corpus.map(({ name, kind, source }) => ({ name, kind, source }))).toEqual(sources)
})

function structure(root: Element, preview: boolean): unknown {
  return {
    tag: root.localName,
    attributes: Array.from(root.attributes, (attr) => attr.name)
      .filter(
        (name) =>
          !name.startsWith('xmlns') &&
          !(
            name === 'style' &&
            !(preview ? (root as SVGElement).style.cssText : root.getAttribute(name))
          ),
      )
      .sort(),
    text: root.children.length ? null : root.textContent,
    children: Array.from(root.children)
      .filter((child) => !preview || child.localName !== 'style')
      .map((child) => structure(child, preview)),
  }
}

for (const { name, svg: markup, kind } of corpus) {
  it(`preserves the frame's ${name} drawing in preview and HTML export`, () => {
    const raw = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
    const imported = importSvg(markup)
    expect(structure(imported.svg, true)).toEqual(structure(raw, true))
    const css = Array.from(raw.querySelectorAll('style'), (style) => style.textContent).join('\n')
    expect(imported.css.replaceAll(imported.svg.id, raw.id)).toBe(css)
    const { html } = pageBody(
      {
        type: 'root',
        children: [
          {
            type: 'element',
            tagName: 'div',
            properties: { dataDevotIsland: kind, dataIslandSource: 'corpus' },
            children: [],
          },
        ],
      },
      { nonce: '0123456789abcdef0123456789abcdef', island: () => markup },
    )
    const doc = new DOMParser().parseFromString(html, 'image/svg+xml')
    const exported = doc.querySelector('svg')
    expect(exported).not.toBeNull()
    expect(structure(exported!, false)).toEqual(structure(raw, false))
  })
}
