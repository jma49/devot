import { describe, expect, it, vi } from 'vitest'
import { renderPreviewPieces } from '../../core/preview'
import type { Core } from './core-client'
import { previewLabels } from './preview/Preview'
import { WARM_LANGUAGES, WARM_SAMPLE, warmUp } from './warmUp'

describe('warmUp', () => {
  it('renders a sample with every warmed language, math and emoji once the window is idle', () => {
    const pieces = vi.fn<() => Promise<unknown>>(() => Promise.resolve([]))
    const core = { renderPreviewPieces: pieces } as unknown as Core
    let run: (() => void) | undefined
    warmUp(core, (task) => {
      run = task
    })
    expect(pieces).not.toHaveBeenCalled()
    run!()
    expect(pieces).toHaveBeenCalledTimes(1)
    for (const lang of WARM_LANGUAGES) expect(WARM_SAMPLE).toContain(`\`\`\`${lang}\n`)
    expect(WARM_SAMPLE).toMatch(/\$[^$]+\$/)
    expect(WARM_SAMPLE).toMatch(/:[a-z_]+:/)
  })

  it('runs the path a long note takes: several pieces, patched into a page', async () => {
    const pieces = await renderPreviewPieces(
      WARM_SAMPLE,
      { labels: previewLabels(), loadedEmbeds: [] },
      [],
    )
    expect(pieces.length).toBeGreaterThan(1)
    const patched = vi.fn<() => void>()
    const core = {
      renderPreviewPieces: () => Promise.resolve(pieces).finally(patched),
    } as unknown as Core
    warmUp(core, (task) => task())
    await vi.waitFor(() => expect(patched).toHaveBeenCalled())
  })

  it('swallows a failed render', async () => {
    const core = { renderPreviewPieces: () => Promise.reject(new Error('E_X')) } as unknown as Core
    expect(() => warmUp(core, (task) => task())).not.toThrow()
    await Promise.resolve()
  })
})
