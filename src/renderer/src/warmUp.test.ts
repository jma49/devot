import { describe, expect, it, vi } from 'vitest'
import type { Core } from './core-client'
import { WARM_LANGUAGES, WARM_SAMPLE, warmUp } from './warmUp'

describe('warmUp', () => {
  it('renders a sample with every warmed language, math and emoji once the window is idle', () => {
    const renderPreview = vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve({ type: 'root', children: [] }),
    )
    const core = { renderPreview } as unknown as Core
    let run: (() => void) | undefined
    warmUp(core, (task) => {
      run = task
    })
    expect(renderPreview).not.toHaveBeenCalled()
    run!()
    expect(renderPreview).toHaveBeenCalledTimes(1)
    for (const lang of WARM_LANGUAGES) expect(WARM_SAMPLE).toContain(`\`\`\`${lang}\n`)
    expect(WARM_SAMPLE).toMatch(/\$[^$]+\$/)
    expect(WARM_SAMPLE).toMatch(/:[a-z_]+:/)
  })

  it('swallows a failed render', async () => {
    const core = { renderPreview: () => Promise.reject(new Error('E_X')) } as unknown as Core
    expect(() => warmUp(core, (task) => task())).not.toThrow()
    await Promise.resolve()
  })
})
