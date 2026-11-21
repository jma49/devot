// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import mermaid from 'mermaid'
import { DIAGRAM_ENGINES } from '../../../../scripts/vite/mermaid-frame-entry'
import corpus from '../../../../tests/fixtures/diagram-svg.json'
import sources from '../../../../tests/fixtures/diagram-corpus.json'
import { pageBody } from '../../../core/htmlExport'
import { importSvg } from './mermaid'

function exportedSvg(markup: string): Element {
  const { html } = pageBody(
    {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'div',
          properties: {
            dataDevotIsland: 'mermaid',
            dataIslandSource: 'test',
          },
          children: [],
        },
      ],
    },
    { nonce: '0123456789abcdef0123456789abcdef', island: () => markup },
  )
  return new DOMParser().parseFromString(html, 'image/svg+xml').querySelector('svg')!
}

vi.hoisted(() => {
  document.insertBefore(
    document.implementation.createDocumentType('html', '', ''),
    document.documentElement,
  )
})

it('records every source in the diagram corpus', () => {
  expect(corpus.map(({ name, kind, source }) => ({ name, kind, source }))).toEqual(sources)
})

it('covers every registered diagram type and frame engine', () => {
  mermaid.initialize({ startOnLoad: false })
  const registered = mermaid
    .getRegisteredDiagramsMetadata()
    .map(({ id }) => id)
    .filter((id) => id !== 'error' && id !== '---')
  const covered = sources
    .filter(({ kind }) => kind === 'mermaid')
    .map(({ source }) => mermaid.detectType(source))
  expect([...new Set(covered)].sort()).toEqual(registered.sort())
  expect([...new Set(sources.map(({ kind }) => kind))].sort()).toEqual([...DIAGRAM_ENGINES].sort())
})

it('keeps local gradient and clipping references but rejects remote paint on both paths', () => {
  const markup =
    '<svg xmlns="http://www.w3.org/2000/svg" id="d"><defs>' +
    '<linearGradient id="gradient"><stop offset="0%" stop-color="red"/><stop offset="100%" stop-color="url(https://evil.example/paint)"/></linearGradient>' +
    '<clipPath id="clip"><rect width="10" height="10"/></clipPath></defs>' +
    '<rect width="10" height="10" fill="url(#gradient)"/>' +
    '<text clip-path="url(#clip)">Local</text>' +
    '<rect fill="url(https://evil.example/fill)"/><text clip-path="url(https://evil.example/clip)">Remote</text></svg>'
  const imported = importSvg(markup).svg
  const { html } = pageBody(
    {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'div',
          properties: { dataDevotIsland: 'mermaid', dataIslandSource: 'test' },
          children: [],
        },
      ],
    },
    { nonce: '0123456789abcdef0123456789abcdef', island: () => markup },
  )
  const exported = new DOMParser().parseFromString(html, 'image/svg+xml').querySelector('svg')!
  for (const svg of [imported, exported]) {
    expect(svg.querySelectorAll('linearGradient stop')).toHaveLength(2)
    expect(svg.querySelector('stop')?.getAttribute('stop-color')).toBe('red')
    expect(svg.querySelectorAll('stop')[1]!.hasAttribute('stop-color')).toBe(false)
    expect(svg.querySelector('svg > rect')?.getAttribute('fill')).toBe('url(#gradient)')
    expect(svg.querySelector('text')?.getAttribute('clip-path')).toBe('url(#clip)')
    expect(svg.querySelectorAll('svg > rect')[1]!.hasAttribute('fill')).toBe(false)
    expect(svg.querySelectorAll('text')[1]!.hasAttribute('clip-path')).toBe(false)
    expect(svg.outerHTML).not.toContain('evil.example')
  }
})

it('replaces foreign HTML with centred plain text on both paths', () => {
  const markup =
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject x="10" y="20" width="100" height="40" onload="bad()">' +
    '<div xmlns="http://www.w3.org/1999/xhtml" style="color:red" id="html-label"> Before  <b>bold</b>\n' +
    '<script>bad()</script><img src="https://evil.example/image" onerror="bad()"/>' +
    '<a href="javascript:bad()"> Link </a> After </div></foreignObject></svg>'
  for (const svg of [importSvg(markup).svg, exportedSvg(markup)]) {
    expect(svg.children).toHaveLength(1)
    const label = svg.firstElementChild!
    expect(label.localName).toBe('text')
    expect(label.textContent).toBe('Before bold bad() Link After')
    expect(label.children).toHaveLength(0)
    expect(
      Object.fromEntries(Array.from(label.attributes, (attr) => [attr.name, attr.value])),
    ).toEqual({
      x: '60',
      y: '40',
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
    })
    expect(svg.outerHTML).not.toMatch(
      /foreignObject|<script|<img|<a\b|onerror|onload|javascript:|evil\.example|html-label/,
    )
  }
})

it('handles empty foreign objects and invalid box coordinates without copying attributes', () => {
  const markup =
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject x="NaN" y="Infinity" width="bad" height="1e999" class="discard"/></svg>'
  for (const svg of [importSvg(markup).svg, exportedSvg(markup)]) {
    expect(svg.querySelector('text')?.textContent).toBe('')
    expect(svg.querySelector('text')?.getAttribute('x')).toBe('0')
    expect(svg.querySelector('text')?.getAttribute('y')).toBe('0')
    expect(svg.querySelector('text')?.hasAttribute('class')).toBe(false)
  }
})

it('keeps event-modeling labels as SVG text in both paths', () => {
  const markup = corpus.find(({ name }) => name === 'eventmodeling')!.svg
  for (const svg of [importSvg(markup).svg, exportedSvg(markup)]) {
    expect(svg.querySelector('foreignObject')).toBeNull()
    const labels = Array.from(svg.querySelectorAll('text'), (text) => text.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Editor', 'SaveNote', 'NoteSaved']))
  }
})

function structure(root: Element, preview: boolean): unknown {
  if (root.localName === 'foreignObject')
    return {
      tag: 'text',
      attributes: ['dominant-baseline', 'text-anchor', 'x', 'y'],
      text: root.textContent?.replace(/\s+/g, ' ').trim(),
      children: [],
    }
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
