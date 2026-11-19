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
import { textStore } from '../textStore'
import { Preview } from './Preview'
import type { ScrollPane } from './scrollSync'
import { warmMermaid } from './mermaid'

vi.mock('./mermaid', async (original) => ({
  ...(await original<typeof import('./mermaid')>()),
  warmMermaid: vi.fn<typeof warmMermaid>(() => () => undefined),
}))

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
type RenderAnswer = Awaited<ReturnType<Core['renderLivePreview']>>

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
    noteDrawings: async () => [],
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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

/** `show` for a preview that follows a text store, as Split view's does. */
function follow(core: Core, markdown: string, noteId: string) {
  const at = document.createElement('div')
  document.body.append(at)
  root = createRoot(at)
  const text = textStore(markdown, (run) => setTimeout(run, 0))
  const open = (id: string) =>
    act(() => {
      root!.render(<Preview core={core} text={text} noteId={id} onOpenNote={() => undefined} />)
    })
  open(noteId)
  const type = (next: string) => act(() => text.changed(() => next))
  return { open, type, body: () => at.querySelector('.preview-body')! }
}

/** Waits for the first render to reach the page, but for no timer the page set. */
const firstRender = async (renders: Promise<unknown>[]) => {
  await act(async () => {
    // A note with a fence reads its kept drawings before its first render.
    for (let i = 0; i < 20 && renders.length === 0; i += 1) await Promise.resolve()
    await renders[0]
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
  })
}

describe('Preview', () => {
  it('stops building the old tail as soon as another note opens', async () => {
    const { core, renders } = fakeCore()
    const render = core.renderLivePreview
    let finish!: (answer: RenderAnswer) => void
    const short = '# New short note'
    const pending = new Promise<RenderAnswer>((resolve) => {
      finish = resolve
    })
    core.renderLivePreview = vi
      .fn<Core['renderLivePreview']>()
      .mockImplementation((source, ...args) =>
        source === short ? pending : render(source, ...args),
      )
    const { body, render: update } = show(core, note(100_000, 'old-tail'), 'old-tail')
    await firstRender(renders)
    const sections = body().querySelectorAll('h2').length
    update(short, 'short-note')
    await settle()
    expect(body().querySelectorAll('h2')).toHaveLength(sections)
    expect(body().textContent).toContain('old-tail section 1')
    const pieces = await createPieceRenderer()(short, { labels, loadedEmbeds: [] })
    await act(async () => finish({ pieces, lines: 1, links: [], tasks: { done: 0, total: 0 } }))
    await settle()
    expect(body().textContent).toBe('New short note')
  }, 60_000)

  it('treats the first nonempty editor body as the opening', async () => {
    const { core } = fakeCore()
    const asked = vi.spyOn(core, 'renderLivePreview')
    const { type } = follow(core, '', 'loading-body')
    await settle()
    const markdown = `${note(40_000, 'loaded')}\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\``
    type(markdown)
    await settle()
    const opening = asked.mock.calls.find((call) => call[0] === markdown)
    expect(opening?.[4]).toBe(8000)
    expect(vi.mocked(warmMermaid).mock.calls.some(([source]) => source === markdown)).toBe(true)
    type(`${markdown}\nTyped`)
    await settle()
    expect(asked.mock.calls.at(-1)?.[4]).toBeUndefined()
    expect(
      vi
        .mocked(warmMermaid)
        .mock.calls.filter(([source]) => source.startsWith('## loaded section')),
    ).toHaveLength(1)
  }, 60_000)

  it('opens a long note with its head again after visiting a blank note', async () => {
    const { core } = fakeCore()
    const asked = vi.spyOn(core, 'renderLivePreview')
    const markdown = note(40_000, 'return-from-blank')
    const { render: update } = show(core, markdown, 'return-long')
    await settle()
    update('', 'blank-note')
    await settle()
    asked.mockClear()
    update(markdown, 'return-long')
    await settle()
    expect(asked.mock.calls[0]?.[4]).toBe(8000)
  }, 60_000)

  it.each(['ready', 'note', 'error', 'denied'])(
    'handles Copy following head-only Select All: %s',
    async (change) => {
      const copied: { text: string; html: string }[] = []
      vi.stubGlobal(
        'ClipboardItem',
        class {
          constructor(private data: Record<string, Promise<Blob>>) {}
          getType(type: string): Promise<Blob> {
            return this.data[type]!
          }
        },
      )
      const write = vi.spyOn(navigator.clipboard, 'write').mockImplementation(async (items) => {
        if (change === 'denied') throw new Error('E_TEST_CLIPBOARD_DENIED')
        const item = items[0]!
        const [text, html] = await Promise.all([
          item.getType('text/plain').then((blob) => blob.text()),
          item.getType('text/html').then((blob) => blob.text()),
        ])
        copied.push({ text, html })
      })
      const markdown = `${note(40_000, 'copy')}\n\nTAIL_NEEDLE`
      const renderer = createPieceRenderer()
      const head = await renderer.head(markdown, { labels, loadedEmbeds: [] }, [], 8000)
      const full = await renderer(
        markdown,
        { labels, loadedEmbeds: [] },
        head.pieces.map((piece) => piece.key),
      )
      let finish!: (answer: RenderAnswer) => void
      let fail!: (error: Error) => void
      const done = new Promise<RenderAnswer>((resolve, reject) => {
        finish = resolve
        fail = reject
      })
      const { core } = fakeCore()
      const render = core.renderLivePreview
      core.renderLivePreview = vi
        .fn<Core['renderLivePreview']>()
        .mockResolvedValueOnce({ ...head, lines: 10000, links: [], tasks: { done: 0, total: 0 } })
        .mockReturnValueOnce(done)
        .mockImplementation(render)
      const { body, render: update } = show(core, markdown, 'copy-head')
      await settle()
      expect(body().textContent).not.toContain('TAIL_NEEDLE')
      window.getSelection()!.selectAllChildren(body())
      const pane = body().closest('.preview')!
      act(() => {
        pane.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        )
      })
      const copy = new Event('copy', { bubbles: true, cancelable: true })
      act(() => {
        pane.dispatchEvent(copy)
      })
      expect(write).toHaveBeenCalledOnce()
      if (change === 'note') update('# Other note', 'other-copy')
      await act(async () => {
        if (change === 'error') fail(new Error('E_TEST_FULL'))
        else finish({ pieces: full, lines: 10000, links: [], tasks: { done: 0, total: 0 } })
      })
      await settle()
      expect(copy.defaultPrevented).toBe(true)
      const wholeText = expect.stringContaining('TAIL_NEEDLE')
      const wholeHtml = expect.stringContaining('TAIL_NEEDLE')
      expect(copied).toEqual(change === 'ready' ? [{ text: wholeText, html: wholeHtml }] : [])
      const fragment = document.createElement('div')
      fragment.innerHTML = copied[0]?.html ?? ''
      expect(fragment.querySelector('strong')?.textContent).toBe(
        change === 'ready' ? 'bold' : undefined,
      )
      expect(fragment.querySelector('a')?.getAttribute('href')).toBe(
        change === 'ready' ? 'https://example.com/1' : undefined,
      )
      const warnings = warned.mock.calls
        .map(([code]) => String(code))
        .filter((code) => code.startsWith('W_PREVIEW'))
      expect(warnings).toEqual(
        change === 'error'
          ? ['W_PREVIEW_RENDER_FAILED']
          : change === 'denied'
            ? ['W_PREVIEW_COPY_FAILED']
            : [],
      )
      warned.mockClear()
    },
    60_000,
  )

  it('adds copy controls only after a paint opportunity and drops a replaced list', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let key = 0
    const request = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((run) => {
      frames.set(++key, run)
      return key
    })
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
    const frame = async () => {
      const callbacks = [...frames.values()]
      frames.clear()
      await act(async () => {
        for (const callback of callbacks) callback(0)
      })
    }
    try {
      const { core, renders } = fakeCore()
      const { body, render } = show(core, '```js\nconst old = 1\n```', 'old-controls')
      await firstRender(renders)
      expect(body().querySelector('.code-copy')).toBeNull()
      await frame()
      expect(body().querySelector('.code-copy')).toBeNull()
      render('No code here.', 'new-controls')
      await act(async () => {
        for (let i = 0; i < 40; i++) await Promise.resolve()
      })
      await frame()
      await frame()
      expect(body().textContent).toBe('No code here.')
      expect(body().querySelector('.code-copy')).toBeNull()
      render('```js\nconst fresh = 2\n```', 'fresh-controls')
      await act(async () => {
        for (let i = 0; i < 40; i++) await Promise.resolve()
      })
      await frame()
      await frame()
      expect(body().querySelectorAll('.code-copy')).toHaveLength(1)
    } finally {
      act(() => root?.unmount())
      root = undefined
      request.mockRestore()
      cancel.mockRestore()
    }
  })

  it('waits for space below a heading near the end of the head before reaching it', async () => {
    const markdown = note(100_000, 'heading-room')
    const renderer = createPieceRenderer()
    const head = await renderer.head(markdown, { labels, loadedEmbeds: [] }, [], 8000)
    let finish!: (answer: RenderAnswer) => void
    const done = new Promise<RenderAnswer>((resolve) => {
      finish = resolve
    })
    const { core } = fakeCore()
    core.renderLivePreview = vi
      .fn<Core['renderLivePreview']>()
      .mockResolvedValueOnce({ ...head, lines: 10000, links: [], tasks: { done: 0, total: 0 } })
      .mockReturnValueOnce(done)
    const { body, handles } = show(core, markdown, 'heading-room')
    await settle()
    const scroller = body().closest<HTMLElement>('.preview')!
    const headings = body().querySelectorAll('h2')
    const heading = headings[headings.length - 1]!
    const top = (headings.length - 1) * 100
    vi.spyOn(heading, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 100, 40))
    vi.spyOn(scroller, 'clientHeight', 'get').mockReturnValue(300)
    vi.spyOn(scroller, 'scrollHeight', 'get').mockImplementation(
      () => body().querySelectorAll('h2').length * 100,
    )
    const reaching = handles.pane!.reach!(Number(heading.getAttribute('data-source-line')))
    expect(reaching).toBeInstanceOf(Promise)
    const pieces = await renderer(
      markdown,
      { labels, loadedEmbeds: [] },
      head.pieces.map((piece) => piece.key),
    )
    await act(async () => finish({ pieces, lines: 10000, links: [], tasks: { done: 0, total: 0 } }))
    await expect(reaching).resolves.toBe(true)
    expect(scroller.scrollHeight >= top + scroller.clientHeight).toBe(true)
  }, 60_000)

  it('shows a long note head before asking for its full render, which reuses the head keys', async () => {
    const markdown = note(40_000, 'head')
    const renderer = createPieceRenderer()
    const head = await renderer.head(markdown, { labels, loadedEmbeds: [] }, [], 8000)
    const full = await renderer(
      markdown,
      { labels, loadedEmbeds: [] },
      head.pieces.map((piece) => piece.key),
    )
    let complete!: (value: RenderAnswer) => void
    const pending = new Promise<RenderAnswer>((resolve) => {
      complete = resolve
    })
    const { core } = fakeCore()
    const asked = vi
      .fn<Core['renderLivePreview']>()
      .mockResolvedValueOnce({ ...head, lines: 1000, links: [], tasks: { done: 0, total: 0 } })
      .mockReturnValueOnce(pending)
    core.renderLivePreview = asked
    const { body, handles, render: update } = show(core, markdown, 'head-sequence')
    await settle()
    expect(asked).toHaveBeenCalledTimes(2)
    expect(asked.mock.calls[0]![4]).toBe(8000)
    expect(asked.mock.calls[1]![4]).toBeUndefined()
    expect(asked.mock.calls[1]![2]).toEqual(head.pieces.map((piece) => piece.key))
    expect(body().textContent).toContain('head section 1')
    expect(body().textContent).not.toContain('head section 150')
    expect(handles.pane?.reach).toBeTypeOf('function')
    expect(handles.pane?.reach?.(1)).toBeUndefined()
    await act(async () =>
      complete({
        pieces: full,
        partial: false,
        lines: 1000,
        links: [],
        tasks: { done: 0, total: 0 },
      }),
    )
    await settle()
    expect(content(body())).toBe(await wholeBuild(markdown))
    asked.mockResolvedValueOnce({ pieces: [], lines: 1, links: [], tasks: { done: 0, total: 0 } })
    update(`${markdown}\n\nTyped`, 'head-sequence')
    await settle()
    expect(asked).toHaveBeenCalledTimes(3)
    expect(asked.mock.calls[2]![4]).toBeUndefined()
  }, 60_000)

  it('drops a full answer after a newer note opens over the head', async () => {
    const markdown = note(40_000, 'previous')
    const renderer = createPieceRenderer()
    const head = await renderer.head(markdown, { labels, loadedEmbeds: [] }, [], 8000)
    let complete!: (value: RenderAnswer) => void
    const pending = new Promise<RenderAnswer>((resolve) => {
      complete = resolve
    })
    const { core } = fakeCore()
    const original = core.renderLivePreview
    const asked = vi
      .fn<Core['renderLivePreview']>()
      .mockResolvedValueOnce({ ...head, lines: 1000, links: [], tasks: { done: 0, total: 0 } })
      .mockReturnValueOnce(pending)
      .mockImplementation(original)
    core.renderLivePreview = asked
    const { body, render: update } = show(core, markdown, 'previous-full')
    await settle()
    update('# Current note', 'current-full')
    await act(async () =>
      complete({
        pieces: await renderer(markdown, { labels, loadedEmbeds: [] }),
        lines: 1000,
        links: [],
        tasks: { done: 0, total: 0 },
      }),
    )
    await settle()
    expect(body().textContent).toContain('Current note')
    expect(body().textContent).not.toContain('previous section')
    expect(asked).toHaveBeenCalledTimes(3)
  }, 60_000)

  it.each(['note', 'text', 'unmount'])(
    'drops a pending head after %s changes',
    async (change) => {
      const markdown = note(40_000, 'old')
      let complete!: (value: RenderAnswer) => void
      const pending = new Promise<RenderAnswer>((resolve) => {
        complete = resolve
      })
      const { core } = fakeCore()
      const render = core.renderLivePreview
      const asked = vi
        .fn<Core['renderLivePreview']>()
        .mockReturnValueOnce(pending)
        .mockImplementation(render)
      core.renderLivePreview = asked
      const { render: update, body } = show(core, markdown, `stale-${change}`)
      await act(async () => {
        for (let i = 0; i < 30; i++) await Promise.resolve()
      })
      if (change === 'unmount')
        act(() => {
          root?.unmount()
          root = undefined
        })
      else update('# New text', change === 'note' ? 'different' : `stale-${change}`)
      const head = await createPieceRenderer().head(
        markdown,
        { labels, loadedEmbeds: [] },
        [],
        8000,
      )
      await act(async () =>
        complete({ ...head, lines: 1000, links: [], tasks: { done: 0, total: 0 } }),
      )
      await settle()
      expect(body()?.textContent ?? '').toBe(change === 'unmount' ? '' : 'New text')
      expect(asked).toHaveBeenCalledTimes(change === 'unmount' ? 1 : 2)
    },
    60_000,
  )

  it('warms Mermaid while fenced-note metadata is still loading', async () => {
    vi.mocked(warmMermaid).mockClear()
    const release = vi.fn<() => void>()
    vi.mocked(warmMermaid).mockReturnValueOnce(release)
    const { core } = fakeCore()
    vi.spyOn(core, 'noteDrawings').mockReturnValue(new Promise(() => {}))
    const render = vi.spyOn(core, 'renderLivePreview')
    show(core, '# Diagram\n\n```mermaid\nflowchart LR\nA-->B\n```', 'warming')
    await act(async () => {
      await Promise.resolve()
    })
    expect(warmMermaid).toHaveBeenCalledOnce()
    expect(render).not.toHaveBeenCalled()
    act(() => {
      root?.unmount()
      root = undefined
    })
    expect(release).toHaveBeenCalledOnce()
  })

  it.each(['head', 'full'])('recovers after the %s request fails', async (phase) => {
    const markdown = note(40_000, 'failed')
    const head = await createPieceRenderer().head(markdown, { labels, loadedEmbeds: [] }, [], 8000)
    const { core } = fakeCore()
    const asked = vi.fn<Core['renderLivePreview']>().mockImplementation(core.renderLivePreview)
    if (phase === 'full')
      asked.mockResolvedValueOnce({ ...head, lines: 1000, links: [], tasks: { done: 0, total: 0 } })
    asked.mockRejectedValueOnce(new Error('E_TEST_RENDER'))
    core.renderLivePreview = asked
    const { render: update, body } = show(core, markdown, `failed-${phase}`)
    await settle()
    expect(warned).toHaveBeenCalledWith('W_PREVIEW_RENDER_FAILED')
    warned.mockClear()
    update('# Recovered', `failed-${phase}`)
    await settle()
    expect(body().textContent).toBe('Recovered')
    expect(asked).toHaveBeenCalledTimes(phase === 'head' ? 2 : 3)
  })

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

  it('builds the rest before Cmd+A selects, so copying takes the whole note', async () => {
    const { core, renders } = fakeCore()
    const markdown = note(60_000, 'big')
    const sections = markdown.split('## ').length - 1
    const { body } = show(core, markdown, 'n1')
    await firstRender(renders)
    expect(body().querySelectorAll('h2').length).toBeLessThan(sections)
    const pane = body().closest('.preview')!
    act(() => {
      pane.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', metaKey: true, bubbles: true }),
      )
    })
    expect(body().querySelectorAll('h2')).toHaveLength(sections)
  }, 60_000)

  it('builds nothing more to read the offset of a line already built', async () => {
    const { core, renders } = fakeCore()
    const { body, handles } = show(core, note(200_000, 'big'), 'n1')
    await firstRender(renders)
    const before = body().querySelectorAll('h2').length
    act(() => {
      for (let i = 0; i < 5; i += 1) void handles.pane!.offsetOf(5)
    })
    expect(body().querySelectorAll('h2')).toHaveLength(before)
  }, 60_000)

  it('leaves copy controls until the whole preview has been built and can paint', async () => {
    const { core, renders } = fakeCore()
    const markdown = note(100_000, 'big')
    const sections = markdown.split('## ').length - 1
    const { body } = show(core, markdown, 'n1')
    await firstRender(renders)
    const first = body().querySelectorAll('.code-copy').length
    const real = performance.now.bind(performance)
    let skew = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => real() + skew)
    let grewMidway = false
    try {
      while (body().querySelectorAll('h2').length < sections) {
        if (body().querySelectorAll('.code-copy').length > first) grewMidway = true
        skew += 1000
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
      }
    } finally {
      now.mockRestore()
    }
    expect(grewMidway).toBe(false)
    await settle()
    expect(body().querySelectorAll('.code-copy')).toHaveLength(sections)
  }, 60_000)

  it('shows text split off near the end of what is built in the task of the edit', async () => {
    const { core, renders } = fakeCore()
    const markdown = note(60_000, 'big')
    const { render, body } = show(core, markdown, 'n1')
    await firstRender(renders)
    const last = Array.from(body().querySelectorAll('h2')).at(-1)!.textContent
    const n = /section (\d+)/.exec(last)![1]
    const edited = markdown.replace(
      `Paragraph ${n} of big with`,
      `Paragraph ${n} of big\n\nSplit off with`,
    )
    render(edited, 'n1')
    await act(async () => {
      await renders[1]
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    expect(body().textContent).toContain('Split off with')
  }, 60_000)

  it('maps lines to the blocks of a note opened while the last one still builds', async () => {
    // Blocks sit 10 pixels a line down in the scrolled pane; one no longer on the page sits nowhere near.
    const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const line = Number(this.getAttribute('data-source-line') ?? 0)
      const scrolled = line > 0 ? (this.closest('.preview')?.scrollTop ?? 0) : 0
      const top = this.isConnected ? line * 10 - scrolled : -100_000
      return { top, bottom: top + 10, left: 0, right: 100, width: 100, height: 10 } as DOMRect
    })
    try {
      const { core, renders } = fakeCore()
      const { render, body, handles } = show(core, note(200_000, 'one'), 'n1')
      await firstRender(renders)
      const lineOf = (markdown: string, heading: string) =>
        markdown.slice(0, markdown.indexOf(`## ${heading}`)).split('\n').length
      const first = note(200_000, 'one')
      expect(handles.pane!.offsetOf(lineOf(first, 'one section 3'))).toBe(
        lineOf(first, 'one section 3') * 10,
      )
      const other = `Intro\n\n${note(200_000, 'two')}`
      render(other, 'n2')
      await act(async () => {
        await renders[1]
        for (let i = 0; i < 20; i += 1) await Promise.resolve()
      })
      const sections = other.split('## ').length - 1
      expect(body().querySelectorAll('h2').length).toBeLessThan(sections)
      // A look below what is built first passes over the pieces still waiting.
      const pane = body().closest<HTMLElement>('.preview')!
      pane.scrollTop = lineOf(other, 'two section 899') * 10
      handles.pane!.topLine()
      for (const heading of ['two section 3', 'two section 900']) {
        const line = lineOf(other, heading)
        expect(handles.pane!.offsetOf(line)).toBe(line * 10)
      }
      await settle()
      expect(body().querySelectorAll('h2')).toHaveLength(sections)
      const last = lineOf(other, `two section ${sections}`)
      expect(handles.pane!.offsetOf(last)).toBe(last * 10)
    } finally {
      box.mockRestore()
    }
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

  it('reports scrolls once a restore past the end of the note runs out of time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    try {
      const { core, renders } = fakeCore()
      const at = document.createElement('div')
      document.body.append(at)
      root = createRoot(at)
      const reported: number[] = []
      act(() => {
        root!.render(
          <Preview
            core={core}
            markdown={note(2_000, 'short')}
            noteId="n1"
            onOpenNote={() => undefined}
            initialScroll={() => 5_000}
            onScroll={(top) => reported.push(top)}
          />,
        )
      })
      const pane = at.querySelector<HTMLElement>('.preview')!
      // The note ends at 300 px, short of the saved position.
      let top = 0
      Object.defineProperty(pane, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (value: number) => (top = Math.min(value, 300)),
      })
      await firstRender(renders)
      expect(pane.scrollTop).toBe(300)

      act(() => void vi.advanceTimersByTime(5_001))
      act(() => {
        pane.scrollTop = 120
        pane.dispatchEvent(new Event('scroll'))
      })
      expect(reported).toEqual([120])
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)

  it('shows another note anew when its text follows the switch, while either note still builds', async () => {
    const { core, asked, renders } = fakeCore()
    const first = note(200_000, 'one')
    const { open, type, body } = follow(core, first, 'n1')
    await firstRender(renders)
    const before = body().querySelector('p')!
    expect(body().querySelectorAll('h2').length).toBeLessThan(first.split('## ').length - 1)

    const other = note(60_000, 'two')
    const from = renders.length
    open('n2')
    type(other)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await renders[from]
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    expect(asked[from]).toEqual([])
    expect(body().contains(before)).toBe(false)
    expect(body().querySelectorAll('h2').length).toBeLessThan(other.split('## ').length - 1)

    // Typed in a piece built at once, with pieces still waiting after it.
    const edited = other.replace('Paragraph 2 of two with', 'Paragraph 2 of two, typed, with')
    type(edited)
    await settle()
    expect(asked.at(-1)!.length).toBeGreaterThan(0)
    expect(content(body())).toBe(await wholeBuild(edited))
    expect(body().querySelectorAll('.code-copy')).toHaveLength(edited.split('```ts').length - 1)
  }, 60_000)
})

describe('a note’s kept drawings (ADR 0030)', () => {
  const drawingsCore = () => {
    const { core, renders } = fakeCore()
    const kept: (readonly string[] | undefined)[] = []
    const reads: string[] = []
    const render = core.renderLivePreview
    Object.assign(core, {
      renderLivePreview: (
        markdown: string,
        options: Omit<PreviewOptions, 'noteLinks'>,
        known: string[],
        scope: string,
      ) => {
        kept.push(options.keptLanguages)
        return render(markdown, options, known, scope)
      },
      noteDrawings: async (id: string) => {
        reads.push(id)
        return [
          {
            pluginId: 'com.example.graphviz',
            language: 'dot',
            hash: 'a'.repeat(64),
            appearance: 'light',
            svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
          },
        ]
      },
    })
    return { core, renders, kept, reads }
  }

  it('waits for them before the first render of a note with a fence', async () => {
    const { core, renders, kept } = drawingsCore()
    show(core, '```dot\na -> b\n```\n', '0192a6f0-0000-7000-8000-00000000d001')
    await settle()
    await firstRender(renders)
    expect(kept[0]).toEqual(['dot'])
  })

  it('reads none for a note without a fence', async () => {
    const { core, renders, kept, reads } = drawingsCore()
    show(core, 'Just text.\n', '0192a6f0-0000-7000-8000-00000000d002')
    await settle()
    await firstRender(renders)
    expect(kept[0]).toBeUndefined()
    expect(reads).toEqual([])
  })
})
