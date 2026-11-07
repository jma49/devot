// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderPreviewPieces } from '../../core/preview'
import type { WarmFeatures } from '../../core/preview/warmFeatures'
import type { Core } from './core-client'
import { previewLabels } from './preview/Preview'
import { renderHook, unmountAll } from '../../../tests/support/render-hook'
import { useWarmUp, warmSample, warmUp, type WarmSource } from './warmUp'

afterEach(unmountAll)

const NONE: WarmFeatures = { languages: [], math: false, emoji: false }

describe('warmSample', () => {
  it('holds only the blocks every note may show when the notes use no code, math or emoji', () => {
    const sample = warmSample(NONE)
    expect(sample).not.toContain('```')
    expect(sample).not.toContain('$')
    expect(sample).not.toMatch(/:[a-z_]+:/)
    expect(sample).toContain('| A | B |')
  })

  it('adds the code languages, math and emoji the notes use', () => {
    const sample = warmSample({ languages: ['python', 'rust'], math: true, emoji: true })
    expect(sample).toContain('```python\n')
    expect(sample).toContain('```rust\n')
    expect(sample).toMatch(/\$[^$]+\$/)
    expect(sample).toMatch(/:[a-z_]+:/)
  })
})

interface Calls {
  features: ReturnType<typeof vi.fn<(text: string, listed: string[]) => Promise<WarmFeatures>>>
  pieces: ReturnType<typeof vi.fn<(markdown: string) => Promise<unknown[]>>>
}

function fakeCore(features: WarmFeatures, pieces: () => Promise<unknown[]> = async () => []) {
  const calls: Calls = {
    features: vi.fn<(text: string, listed: string[]) => Promise<WarmFeatures>>(
      async () => features,
    ),
    pieces: vi.fn<(markdown: string) => Promise<unknown[]>>(pieces),
  }
  const core = {
    warmFeatures: calls.features,
    renderPreviewPieces: calls.pieces,
  } as unknown as Core
  return { core, calls }
}

describe('warmUp', () => {
  it('asks what the open note and the listed notes use once the window is idle, then renders that', async () => {
    const features: WarmFeatures = { languages: ['go'], math: true, emoji: false }
    const { core, calls } = fakeCore(features)
    const source = vi.fn<WarmSource>(() => ({ text: 'open', listed: ['a', 'b'] }))
    let run: (() => void) | undefined
    warmUp(core, source, (task) => {
      run = task
    })
    expect(source).not.toHaveBeenCalled()
    expect(calls.features).not.toHaveBeenCalled()
    run!()
    expect(calls.features).toHaveBeenCalledWith('open', ['a', 'b'])
    await vi.waitFor(() => expect(calls.pieces).toHaveBeenCalledTimes(1))
    expect(calls.pieces.mock.calls[0]![0]).toBe(warmSample(features))
  })

  it('runs the path a long note takes: several pieces, patched into a page', async () => {
    const pieces = await renderPreviewPieces(
      warmSample(NONE),
      { labels: previewLabels(), loadedEmbeds: [] },
      [],
    )
    expect(pieces.length).toBeGreaterThan(1)
    const patched = vi.fn<() => void>()
    const { core } = fakeCore(NONE, () => Promise.resolve(pieces).finally(patched))
    warmUp(
      core,
      () => ({ text: '', listed: [] }),
      (task) => task(),
    )
    await vi.waitFor(() => expect(patched).toHaveBeenCalled())
  })

  it('swallows a failed render', async () => {
    const { core, calls } = fakeCore(NONE, () => Promise.reject(new Error('E_X')))
    expect(() =>
      warmUp(
        core,
        () => ({ text: '', listed: [] }),
        (task) => task(),
      ),
    ).not.toThrow()
    await vi.waitFor(() => expect(calls.pieces).toHaveBeenCalled())
  })
})

describe('useWarmUp', () => {
  it('warms once the window is ready, with the text and listed notes it holds when idle', async () => {
    const { core, calls } = fakeCore(NONE)
    const tasks: (() => void)[] = []
    const schedule = (task: () => void) => void tasks.push(task)
    let text = 'restored'
    const hook = renderHook(
      ({ ready, listed }: { ready: boolean; listed: string[] }) =>
        useWarmUp(core, ready, () => text, listed, schedule),
      { props: { ready: false, listed: [] as string[] } },
    )
    expect(tasks).toHaveLength(0)
    hook.rerender({ ready: true, listed: [] })
    hook.rerender({ ready: true, listed: ['a'] })
    text = 'typed'
    hook.rerender({ ready: true, listed: ['a', 'b'] })
    expect(tasks).toHaveLength(1)
    tasks[0]!()
    expect(calls.features).toHaveBeenCalledWith('typed', ['a', 'b'])
    await vi.waitFor(() => expect(calls.pieces).toHaveBeenCalledTimes(1))
  })
})
