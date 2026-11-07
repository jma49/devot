// The page's half of the native screens' spike harness (docs/specs/iphone-screens.md, Spikes), in
// debug builds only: useSpikes imports it behind TAURI_ENV_DEBUG, and the release build fails if it
// is in dist/ (scripts/sentry/ui.ts). Swift calls `call(name, args)` and reads the JSON back.
// Nothing here reads, shows or sends note content: the editors and lists it draws hold made-up text.

export const SPIKES_GLOBAL = '__devotSpikes'

/** What the page gives the probes; undefined until the core has started. */
export interface SpikeDeps {
  /** A call the core worker answers at once. */
  readonly ping: () => Promise<unknown>
  readonly sync: () => { readonly enabled: boolean; readonly state: string }
  /** Asks the sync engine to run now. */
  readonly touchSync: () => void
}

const round = (ms: number) => Math.round(ms * 100) / 100

/** The nearest-rank percentile, as the Swift harness takes it; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!
}

export interface PingReport {
  readonly sent: number
  readonly answered: number
  /** Pings answered after their interval, or not answered by the end. */
  readonly missed: number
  /** The longest time with no answer, from the start to the end. */
  readonly maxGapMs: number
}

export function pingWatch(intervalMs: number, start: number) {
  const waiting = new Map<number, number>()
  let next = 0
  let answered = 0
  let late = 0
  let lastAnswer = start
  let maxGap = 0
  return {
    send(at: number): number {
      waiting.set(next, at)
      return next++
    },
    answer(id: number, at: number): void {
      const sentAt = waiting.get(id)
      if (sentAt === undefined) return
      waiting.delete(id)
      answered++
      if (at - sentAt > intervalMs) late++
      maxGap = Math.max(maxGap, at - lastAnswer)
      lastAnswer = at
    },
    finish(at: number): PingReport {
      const lost = [...waiting.values()].filter((sentAt) => at - sentAt > intervalMs).length
      return {
        sent: next,
        answered,
        missed: late + lost,
        maxGapMs: round(Math.max(maxGap, at - lastAnswer)),
      }
    },
  }
}

export interface FrameReport {
  readonly frames: number
  readonly budgetMs: number
  readonly medianMs: number
  readonly p95Ms: number
  readonly maxMs: number
  /** Frames that took more than one and a half budgets, so at least one refresh was missed. */
  readonly overBudget: number
}

export function frameStats(deltas: readonly number[], budgetMs: number): FrameReport {
  return {
    frames: deltas.length,
    budgetMs,
    medianMs: round(percentile(deltas, 50) ?? 0),
    p95Ms: round(percentile(deltas, 95) ?? 0),
    maxMs: round(deltas.length === 0 ? 0 : Math.max(...deltas)),
    overBudget: deltas.filter((delta) => delta > budgetMs * 1.5).length,
  }
}

export interface WatchReport {
  /** Times the page turned anything but visible. */
  readonly hidden: number
  readonly pings: PingReport
  readonly viewport: {
    readonly resizes: number
    readonly width: number
    readonly height: number
  }
  readonly sync: {
    readonly enabled: boolean
    readonly states: readonly string[]
  }
}

/** Spike S1's page side: pings the core every interval while Swift moves the web view. */
export function startWatch(deps: SpikeDeps, intervalMs: number) {
  const pings = pingWatch(intervalMs, performance.now())
  const width = innerWidth
  const height = innerHeight
  const { enabled, state } = deps.sync()
  const states = new Set([state])
  let hidden = 0
  let resizes = 0
  const visibility = () => {
    if (document.visibilityState !== 'visible') hidden++
  }
  const resize = () => {
    if (innerWidth !== width || innerHeight !== height) resizes++
  }
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('resize', resize)
  const timer = setInterval(() => {
    const id = pings.send(performance.now())
    deps.ping().then(
      () => pings.answer(id, performance.now()),
      () => {},
    )
    states.add(deps.sync().state)
  }, intervalMs)
  if (enabled) deps.touchSync()
  return {
    stop(): WatchReport {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('resize', resize)
      return {
        hidden,
        pings: pings.finish(performance.now()),
        viewport: { resizes, width, height },
        sync: { enabled, states: [...states] },
      }
    },
  }
}

type Args = Readonly<Record<string, unknown>>
type Probe = (args: Args) => Promise<unknown>

const number = (args: Args, key: string, fallback: number): number => {
  const value = args[key]
  return typeof value === 'number' ? value : fallback
}

const STAGE_ID = 'devot-spike-stage'

function stage(): HTMLElement {
  const found = document.getElementById(STAGE_ID)
  if (found) return found
  const element = document.createElement('div')
  element.id = STAGE_ID
  element.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;overflow:auto;background:var(--color-phone-background);color:var(--color-phone-text)'
  document.body.append(element)
  return element
}

const madeUpLines = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    i % 7 === 3
      ? `Spike line ${i + 1}, a longer one that wraps on a phone's width so heights vary down the note.`
      : `Spike line ${i + 1}`,
  ).join('\n')

async function editor(parent: HTMLElement, pageScrolls: boolean) {
  const [{ EditorView }, { EditorState }] = await Promise.all([
    import('@codemirror/view'),
    import('@codemirror/state'),
  ])
  const theme = pageScrolls
    ? EditorView.theme({
        '&': { height: 'auto' },
        '.cm-scroller': { overflow: 'visible' },
      })
    : EditorView.theme({ '&': { height: '50vh' } })
  const doc = madeUpLines(pageScrolls ? 1500 : 40)
  return new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [theme, EditorView.lineWrapping] }),
  })
}

/** Rows drawn for spike S3's scroll, `requestAnimationFrame` deltas measured while it runs. */
function scroller(budgetMs: number) {
  const list = stage()
  list.replaceChildren(
    ...Array.from({ length: 3000 }, (_, i) => {
      const row = document.createElement('div')
      row.style.cssText = 'height:64px;padding:0 16px'
      row.textContent = `Spike row ${i + 1}`
      return row
    }),
  )
  const deltas: number[] = []
  let last: number | null = null
  let running = true
  const frame = (at: number) => {
    if (!running) return
    if (last !== null) deltas.push(at - last)
    last = at
    list.scrollTop =
      list.scrollTop + list.clientHeight >= list.scrollHeight ? 0 : list.scrollTop + 6
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  return {
    stop(): FrameReport {
      running = false
      list.remove()
      return frameStats(deltas, budgetMs)
    },
  }
}

/** Where the page's focus is, by kind and tag name only, for spike S2. */
export function focusTarget(editorDOM: Element | undefined) {
  const active = document.activeElement
  const kind =
    active === null
      ? 'none'
      : editorDOM?.contains(active)
        ? 'editor'
        : active.hasAttribute('data-keyboard-proxy')
          ? 'keyboardProxy'
          : active === document.body
            ? 'body'
            : 'other'
  return {
    active: kind,
    activeTag: active?.tagName ?? 'none',
    documentFocused: document.hasFocus(),
  }
}

function probes(deps: () => SpikeDeps | undefined): Record<string, Probe> {
  let watch: ReturnType<typeof startWatch> | undefined
  let scroll: ReturnType<typeof scroller> | undefined
  let view: Awaited<ReturnType<typeof editor>> | undefined
  const required = () => {
    const found = deps()
    if (!found) throw new Error('E_SPIKE_CORE_NOT_READY')
    return found
  }
  const focusState = () => {
    if (!view) throw new Error('E_SPIKE_NOT_STARTED')
    const head = view.state.selection.main.head
    return {
      focused: view.hasFocus,
      caret: view.hasFocus && view.coordsAtPos(head) !== null,
      ...focusTarget(view.dom),
    }
  }
  const scrolledTo = () => {
    const middle = document.elementFromPoint(innerWidth / 2, innerHeight / 2)
    return {
      scrollY: Math.round(scrollY),
      rendered: middle?.closest('.cm-line') != null,
    }
  }
  return {
    ready: () => Promise.resolve({ ready: deps() !== undefined }),
    s1Start: (args) => {
      watch?.stop()
      watch = startWatch(required(), number(args, 'intervalMs', 100))
      return Promise.resolve({})
    },
    s1Stop: () => {
      if (!watch) return Promise.reject(new Error('E_SPIKE_NOT_STARTED'))
      const report = watch.stop()
      watch = undefined
      return Promise.resolve(report)
    },
    s2Mount: async () => {
      view ??= await editor(stage(), false)
      return {}
    },
    s2Focus: () => {
      if (!view) return Promise.reject(new Error('E_SPIKE_NOT_STARTED'))
      view.focus()
      view.dispatch({ selection: { anchor: view.state.doc.length } })
      return Promise.resolve(focusState())
    },
    s2State: () => Promise.resolve(focusState()),
    s2Blur: () => {
      view?.contentDOM.blur()
      return Promise.resolve({})
    },
    s3ScrollStart: (args) => {
      scroll?.stop()
      scroll = scroller(number(args, 'budgetMs', 1000 / 60))
      return Promise.resolve({})
    },
    s3ScrollStop: () => {
      if (!scroll) return Promise.reject(new Error('E_SPIKE_NOT_STARTED'))
      const report = scroll.stop()
      scroll = undefined
      return Promise.resolve(report)
    },
    // The document itself scrolls, so the web view's scroll view does: the shell stays hidden
    // until the app is opened again.
    s4Mount: async () => {
      document.getElementById('root')?.style.setProperty('display', 'none')
      for (const element of [document.documentElement, document.body]) {
        element.style.setProperty('overflow', 'visible')
        element.style.setProperty('height', 'auto')
        element.style.setProperty('overscroll-behavior', 'auto')
      }
      const page = document.createElement('div')
      page.style.cssText = 'background:var(--color-phone-background);color:var(--color-phone-text)'
      document.body.append(page)
      view?.destroy()
      view = await editor(page, true)
      return {}
    },
    s4Measure: () => {
      if (!view) return Promise.reject(new Error('E_SPIKE_NOT_STARTED'))
      return Promise.resolve({
        documentHeight: Math.round(document.scrollingElement?.scrollHeight ?? 0),
        editorHeight: Math.round(view.contentHeight),
        lines: view.state.doc.lines,
        renderedLines: view.contentDOM.querySelectorAll('.cm-line').length,
      })
    },
    s4Probe: () => Promise.resolve(scrolledTo()),
    cleanup: () => {
      watch?.stop()
      watch = undefined
      scroll?.stop()
      scroll = undefined
      view?.destroy()
      view = undefined
      document.getElementById(STAGE_ID)?.remove()
      return Promise.resolve({})
    },
  }
}

/** Puts the probes where Swift's `callAsyncJavaScript` finds them; returns their removal. */
export function installSpikes(deps: () => SpikeDeps | undefined): () => void {
  const table = probes(deps)
  const call = (name: string, args: Args) => {
    const probe = Object.hasOwn(table, name) ? table[name] : undefined
    return probe ? probe(args) : Promise.reject(new Error('E_SPIKE_UNKNOWN_CALL'))
  }
  Object.assign(window, { [SPIKES_GLOBAL]: { call } })
  return () => Reflect.deleteProperty(window, SPIKES_GLOBAL)
}
