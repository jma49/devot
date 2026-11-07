// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createPieceRenderer, type PreviewOptions } from '../../../core'
import { createLivePreviewRenderer } from '../../../core/preview/live'
import { labels } from '../../../../tests/support/preview-html'
import type { Core } from '../core-client'
import type { FindTarget } from '../find/target'
import { patchPieces, UI_ATTRIBUTE } from './dom'
import { Preview } from './Preview'
import type { ScrollPane } from './scrollSync'

vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const section = (n: number, tag: string) =>
  `## ${tag} section ${n}\n\nParagraph ${n} of ${tag} with **bold** text, a [link](https://example.com/${n}) and more words to fill the line.\n\n- [ ] Task ${n}\n- [x] Done ${n}\n\n\`\`\`ts\nconst n = ${n}\n\`\`\``

/** A note of about `bytes` characters, its sections named after `tag`. */
const note = (bytes: number, tag: string) => {
  const out: string[] = []
  for (let n = 1, length = 0; length < bytes; n += 1) {
    out.push(section(n, tag))
    length += out.at(-1)!.length + 2
  }
  return out.join('\n\n')
}

type Known = readonly string[]

function fakeCore() {
  const asked: Known[] = []
  const renders: Promise<unknown>[] = []
  const live = createLivePreviewRenderer({
    renderPieces: createPieceRenderer(),
    linkTargets: async () => ({}),
    onTargetsFailed: () => undefined,
  })
  const core = {
    renderLivePreview: (
      markdown: string,
      options: Omit<PreviewOptions, 'noteLinks'>,
      known: string[],
      scope: string,
    ) => {
      asked.push([...known])
      const rendered = live(markdown, options, known, scope)
      renders.push(rendered.catch(() => undefined))
      return rendered
    },
    forgetShownPieces: async () => undefined,
  } as unknown as Core
  return { core, asked, renders }
}

/** The preview body as one whole render of `markdown` builds it, for comparison. */
async function wholeBuild(markdown: string): Promise<string> {
  const render = createPieceRenderer()
  const host = document.createElement('div')
  patchPieces(host, [], await render(markdown, { labels, loadedEmbeds: [] }))
  return host.innerHTML
}

/** What `body` shows of the note, without the page's own controls. */
function content(body: Element): string {
  const copy = body.cloneNode(true) as Element
  for (const ui of copy.querySelectorAll(`[${UI_ATTRIBUTE}]`)) ui.remove()
  return copy.innerHTML
}

let root: Root | undefined
let warned: MockInstance<typeof console.warn>
beforeEach(() => {
  warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  const codes = warned.mock.calls.map(([code]) => String(code))
  warned.mockRestore()
  const preview = codes.filter((code) => code.startsWith('W_PREVIEW'))
  if (preview.length > 0) throw new Error(`preview warned: ${preview.join(', ')}`)
})

const settle = async () => {
  for (let i = 0; i < 400; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function show(core: Core, markdown: string, noteId: string) {
  const at = document.createElement('div')
  document.body.append(at)
  root = createRoot(at)
  const handles: { find?: FindTarget | null; pane?: ScrollPane | null } = {}
  const render = (text: string, id: string) =>
    act(() => {
      root!.render(
        <Preview
          core={core}
          markdown={text}
          noteId={id}
          onOpenNote={() => undefined}
          onFind={(target) => (handles.find = target)}
          onScrollPane={(pane) => (handles.pane = pane)}
        />,
      )
    })
  render(markdown, noteId)
  return { render, handles, body: () => at.querySelector('.preview-body')! }
}

/** Waits for the first render to reach the page, but for no timer the page set. */
const firstRender = async (renders: Promise<unknown>[]) => {
  await act(async () => {
    await renders[0]
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
  })
}

describe('Preview', () => {
  it('builds what a big note shows first at once and the rest later, ending as one whole build', async () => {
    const { core, renders } = fakeCore()
    const markdown = note(200_000, 'big')
    const { body } = show(core, markdown, 'n1')
    await firstRender(renders)
    const first = body().querySelectorAll('h2').length
    const sections = markdown.split('## ').length - 1
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(sections / 4)
    await settle()
    expect(body().querySelectorAll('h2')).toHaveLength(sections)
    expect(content(body())).toBe(await wholeBuild(markdown))
  }, 60_000)

  it('builds the rest at once for find, and up to a line asked for', async () => {
    const { core, renders } = fakeCore()
    const markdown = note(60_000, 'big')
    const sections = markdown.split('## ').length - 1
    const { body, handles } = show(core, markdown, 'n1')
    await firstRender(renders)
    const line = markdown.slice(0, markdown.indexOf('## big section 150')).split('\n').length
    act(() => void handles.pane!.offsetOf(line))
    const headings = Array.from(body().querySelectorAll('h2'), (h) => h.textContent)
    expect(headings).toContain('big section 150')
    expect(headings.length).toBeLessThan(sections)
    act(() => handles.find!.search({ query: 'Task', regexp: false, caseSensitive: false }))
    expect(body().querySelectorAll('h2')).toHaveLength(sections)
    expect(handles.find!.status().total).toBe(sections)
  }, 60_000)

  it('shows another note anew rather than reusing what the last one showed', async () => {
    const { core, asked } = fakeCore()
    const { render, body } = show(core, note(6_000, 'one'), 'n1')
    await settle()
    const before = body().querySelector('p')!
    const other = note(6_000, 'two')
    render(other, 'n2')
    await settle()
    expect(asked.at(-1)).toEqual([])
    expect(body().contains(before)).toBe(false)
    expect(content(body())).toBe(await wholeBuild(other))
  }, 60_000)
})
