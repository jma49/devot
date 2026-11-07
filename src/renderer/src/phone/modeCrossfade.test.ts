// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { crossfadePanes } from './modeCrossfade'

afterEach(() => vi.restoreAllMocks())

function panes() {
  const incoming = document.createElement('div')
  const outgoing = document.createElement('div')
  document.body.append(incoming, outgoing)
  return { incoming, outgoing }
}

const keys = (calls: unknown[][]) =>
  calls.flatMap(([frames]) => (frames as Keyframe[]).flatMap((frame) => Object.keys(frame)))

describe('the Edit and Preview crossfade', () => {
  it('fades and moves the panes, and lets the compositor hint go when done', async () => {
    const animate = vi.spyOn(Element.prototype, 'animate')
    const { incoming, outgoing } = panes()
    const done = crossfadePanes(incoming, outgoing, false)
    expect(incoming.style.willChange).toBe('transform, opacity')
    expect(new Set(keys(animate.mock.calls))).toStrictEqual(new Set(['opacity', 'transform']))
    await done
    expect(incoming.style.willChange).toBe('')
    expect(outgoing.style.willChange).toBe('')
  })

  it('only fades under Reduce Motion', async () => {
    const animate = vi.spyOn(Element.prototype, 'animate')
    const { incoming, outgoing } = panes()
    await crossfadePanes(incoming, outgoing, true)
    expect(new Set(keys(animate.mock.calls))).toStrictEqual(new Set(['opacity']))
  })
})
