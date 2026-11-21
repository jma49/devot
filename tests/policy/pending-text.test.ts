import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'
import { sizes } from '../../src/renderer/src/theme/tokens'

const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))

describe('loading lines (design/motion.md)', () => {
  it('hold back for the pending delay, unseen, before they fade in', () => {
    const pending = rules.find((r) => r.selector === '.pending-text')!
    const animation = pending.body.get('animation')!
    expect(animation).toContain('var(--motion-delay-pending)')
    expect(animation).toMatch(/\bbackwards$/)
    expect(sizes['motion.delay.pending']).toBe('300ms')
  })

  it('cover Settings > Usage and a pasted link being fetched', () => {
    expect(readFileSync('src/renderer/src/settings/UsageSection.tsx', 'utf8')).toMatch(
      /className="pending-text">\s*\{t\('usage\.loading'\)\}/,
    )
    expect(readFileSync('src/renderer/src/editor/pasteChooser.ts', 'utf8')).toMatch(
      /data-state="loading"\]': \{[^}]*var\(--motion-delay-pending\) backwards/,
    )
  })
})
