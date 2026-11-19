type Cancel = () => void
type WorkKind = 'build' | 'commit' | 'advance'
type Work = Record<WorkKind, Cancel | undefined> & {
  selection: Promise<boolean> | undefined
  warming: readonly Cancel[]
}

interface Request {
  note: string | undefined
  source: string
}

interface Waiting extends Request {
  done: Promise<boolean>
  finish: (ready: boolean) => void
}

type Opening = { request: Request; work: Work } & (
  | { phase: 'idle' | 'full' | 'failed' }
  | { phase: 'head'; waiting: Waiting }
)

const emptyWork = (): Work => ({
  build: undefined,
  commit: undefined,
  advance: undefined,
  selection: undefined,
  warming: [],
})

function waitingFor(request: Request): Waiting {
  let finish!: Waiting['finish']
  const done = new Promise<boolean>((resolve) => {
    finish = resolve
  })
  return { ...request, done, finish }
}

export function createOpening(longCharacters: number) {
  let state: Opening = {
    phase: 'idle',
    request: { note: undefined, source: '' },
    work: emptyWork(),
  }
  const change = (next: Opening, reset = false, ready = false) => {
    const before = state
    state = next
    if (reset) {
      before.work.build?.()
      before.work.commit?.()
      before.work.advance?.()
      for (const release of before.work.warming) release()
    }
    if (before.phase === 'head' && (next.phase !== 'head' || next.waiting !== before.waiting))
      before.waiting.finish(ready)
  }
  const work = (next: Work) => change({ ...state, work: next })
  const clear = (kind: WorkKind) => {
    state.work[kind]?.()
    work({ ...state.work, [kind]: undefined })
  }
  return {
    get phase() {
      return state.phase
    },
    get waiting() {
      return state.phase === 'head' ? state.waiting : undefined
    },
    get selection() {
      return state.work.selection
    },
    has: (kind: WorkKind) => state.work[kind] !== undefined,
    clear,
    set: (kind: WorkKind, cancel: Cancel) => {
      clear(kind)
      work({ ...state.work, [kind]: cancel })
    },
    select: (selection: Promise<boolean> | undefined) => work({ ...state.work, selection }),
    warm: (release: Cancel) => work({ ...state.work, warming: [...state.work.warming, release] }),
    release: (release: Cancel) => {
      if (!state.work.warming.includes(release)) return
      release()
      work({ ...state.work, warming: state.work.warming.filter((one) => one !== release) })
    },
    reset: (note?: string, failed = false) =>
      change(
        { phase: failed ? 'failed' : 'idle', request: { note, source: '' }, work: emptyWork() },
        true,
      ),
    current: (request: Request) => state.request === request,
    begin: (note: string | undefined, source: string, askedHead?: boolean) => {
      const opening =
        source.length > 0 &&
        (state.request.note !== note || state.phase === 'idle' || state.phase === 'failed')
      const head = askedHead ?? (opening && source.length > longCharacters)
      const request = { note, source }
      const continuing =
        askedHead === false &&
        state.phase === 'head' &&
        state.request.note === note &&
        state.request.source === source
      if (continuing && state.phase === 'head') {
        clear('advance')
        change({ ...state, request })
      } else {
        const phase = source.length === 0 && state.phase === 'idle' ? 'idle' : 'full'
        change(
          head
            ? { phase: 'head', request, work: emptyWork(), waiting: waitingFor(request) }
            : { phase, request, work: emptyWork() },
          true,
        )
      }
      return { request, opening, head }
    },
    shown: (partial: boolean) => {
      if (partial) {
        if (state.phase !== 'head')
          change({ ...state, phase: 'head', waiting: waitingFor(state.request) })
      } else if (state.phase !== 'idle')
        change({ phase: 'full', request: state.request, work: state.work }, false, true)
    },
  }
}
