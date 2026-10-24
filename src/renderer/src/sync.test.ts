import { describe, expect, it } from 'vitest'
import { runsSync } from './sync'

describe('runsSync', () => {
  it('runs the engine in the first main window only', () => {
    expect(runsSync('main')).toBe(true)
    for (const label of ['main-2', 'main-10', 'note-3', 'settings', 'quick-capture']) {
      expect(runsSync(label)).toBe(false)
    }
  })
})
