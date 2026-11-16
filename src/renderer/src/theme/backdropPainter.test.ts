import { describe, expect, it } from 'vitest'
import {
  createBackdropPainter,
  SETTLE_MS,
  type BackdropJob,
  type PainterHost,
} from './backdropPainter'
import { backdrops } from './tokens'

const paint = backdrops.tide.dark

function fakeHost() {
  let wanted: BackdropJob | null = null
  let now = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  let nextTimer = 1
  const paints: { job: BackdropJob; resolve: (url: string | null) => void; cancelled: boolean }[] =
    []
  const shown: (string | null)[] = []
  const released: string[] = []
  const host: PainterHost = {
    wanted: () => wanted,
    paint(job) {
      let resolve!: (url: string | null) => void
      const done = new Promise<string | null>((r) => (resolve = r))
      const entry = { job, resolve, cancelled: false }
      paints.push(entry)
      return { done, cancel: () => (entry.cancelled = true) }
    },
    show: (painting) => shown.push(painting?.url ?? null),
    release: (url) => released.push(url),
    setTimer(run, ms) {
      timers.set(nextTimer, { at: now + ms, run })
      return nextTimer++
    },
    clearTimer: (id) => timers.delete(id),
  }
  return {
    host,
    paints,
    shown,
    released,
    want(size: number | null) {
      wanted =
        size === null ? null : { key: `tide/${size}`, paint, width: size, height: size, density: 1 }
    },
    advance(ms: number) {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id)
          t.run()
        }
      }
    },
    pendingTimers: () => timers.size,
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('backdrop painter', () => {
  it('paints once the window has settled, then shows the painting', async () => {
    const fake = fakeHost()
    const painter = createBackdropPainter(fake.host)
    fake.want(100)
    painter.update()
    fake.advance(SETTLE_MS - 1)
    expect(fake.paints).toHaveLength(0)
    fake.advance(1)
    expect(fake.paints).toHaveLength(1)
    fake.paints[0]!.resolve('blob:a')
    await settle()
    expect(fake.shown).toEqual(['blob:a'])
  })

  it('waits for a resize or slider drag to stop before painting', () => {
    const fake = fakeHost()
    const painter = createBackdropPainter(fake.host)
    for (let size = 100; size < 110; size++) {
      fake.want(size)
      painter.update()
      fake.advance(SETTLE_MS / 2)
    }
    expect(fake.paints).toHaveLength(0)
    expect(fake.pendingTimers()).toBe(1)
    fake.advance(SETTLE_MS)
    expect(fake.paints.map((p) => p.job.width)).toEqual([109])
  })

  it('goes back to the tokens gradient at once when the window changes, and frees the old painting', async () => {
    const fake = fakeHost()
    const painter = createBackdropPainter(fake.host)
    fake.want(100)
    painter.update()
    fake.advance(SETTLE_MS)
    fake.paints[0]!.resolve('blob:a')
    await settle()
    fake.want(200)
    painter.update()
    expect(fake.shown).toEqual(['blob:a', null])
    expect(fake.released).toEqual(['blob:a'])
  })

  it('drops a painting that finishes after the window moved on', async () => {
    const fake = fakeHost()
    const painter = createBackdropPainter(fake.host)
    fake.want(100)
    painter.update()
    fake.advance(SETTLE_MS)
    fake.want(200)
    painter.update()
    expect(fake.paints[0]!.cancelled).toBe(true)
    fake.paints[0]!.resolve('blob:late')
    await settle()
    expect(fake.shown).toEqual([])
    expect(fake.released).toEqual(['blob:late'])
  })

  it('keeps the tokens gradient when painting fails, and paints again on the next change', async () => {
    const fake = fakeHost()
    const painter = createBackdropPainter(fake.host)
    fake.want(100)
    painter.update()
    fake.advance(SETTLE_MS)
    fake.paints[0]!.resolve(null)
    await settle()
    expect(fake.shown).toEqual([])
    fake.want(120)
    painter.update()
    fake.advance(SETTLE_MS)
    expect(fake.paints).toHaveLength(2)
  })

  it('does nothing for a theme without a gradient, and clears a painting when one is left', async () => {
    const fake = fakeHost()
    const painter = createBackdropPainter(fake.host)
    fake.want(null)
    painter.update()
    fake.advance(SETTLE_MS)
    expect(fake.paints).toHaveLength(0)
    fake.want(100)
    painter.update()
    fake.advance(SETTLE_MS)
    fake.paints[0]!.resolve('blob:a')
    await settle()
    fake.want(null)
    painter.update()
    expect(fake.shown).toEqual(['blob:a', null])
    expect(fake.released).toEqual(['blob:a'])
    expect(fake.pendingTimers()).toBe(0)
  })

  it('repaints nothing when an unrelated change leaves the window as it is', async () => {
    const fake = fakeHost()
    const painter = createBackdropPainter(fake.host)
    fake.want(100)
    painter.update()
    fake.advance(SETTLE_MS)
    fake.paints[0]!.resolve('blob:a')
    await settle()
    painter.update()
    fake.advance(SETTLE_MS)
    expect(fake.paints).toHaveLength(1)
    expect(fake.shown).toEqual(['blob:a'])
  })
})
