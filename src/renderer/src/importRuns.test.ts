import { describe, expect, it } from 'vitest'
import { importRuns } from './importRuns'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** An import of `files` files that asks `stopped` before each, as `importMarkdown` does. */
function fakeImport(files: number, onFile: () => Promise<void> = async () => {}) {
  const imported: number[] = []
  const run = async (stopped: () => boolean | Promise<boolean>) => {
    for (let file = 0; file < files; file += 1) {
      if (await stopped()) return { imported, stopped: true }
      await onFile()
      imported.push(file)
    }
    return { imported, stopped: false }
  }
  return { imported, run }
}

function gate() {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

describe('importRuns', () => {
  it('holds the running import before its next file and lets it go on when resumed', async () => {
    const runs = importRuns()
    const first = gate()
    let files = 0
    const job = fakeImport(3, async () => {
      files += 1
      if (files === 1) await first.opened
    })
    const report = runs.run(job.run)
    await settle()
    let held = false
    const holding = runs.hold().then(() => (held = true))
    await settle()
    expect(held).toBe(false)
    first.open()
    await holding
    expect(job.imported).toEqual([0])
    await settle()
    expect(job.imported).toEqual([0])
    runs.resume()
    expect(await report).toEqual({ imported: [0, 1, 2], stopped: false })
  })

  it('ends a held import where it waits when stopped', async () => {
    const runs = importRuns()
    const job = fakeImport(3)
    await runs.hold()
    const report = runs.run(job.run)
    await runs.hold()
    expect(job.imported).toEqual([])
    await runs.stop()
    expect(await report).toEqual({ imported: [], stopped: true })
  })

  it('holds nothing when no import runs, and a later import runs as asked', async () => {
    const runs = importRuns()
    await runs.hold()
    runs.resume()
    await runs.stop()
    const job = fakeImport(2)
    expect(await runs.run(job.run)).toEqual({ imported: [0, 1], stopped: false })
  })

  it('waits for an import that finishes rather than reaching the hold', async () => {
    const runs = importRuns()
    const last = gate()
    const job = fakeImport(1, () => last.opened)
    const report = runs.run(job.run)
    await settle()
    const holding = runs.hold()
    last.open()
    await holding
    expect(await report).toEqual({ imported: [0], stopped: false })
  })
})
