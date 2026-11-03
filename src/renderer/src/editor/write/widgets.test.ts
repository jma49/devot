import { describe, expect, it } from 'vitest'
import { decorationOf } from './widgets'

const NOTE = '0192f0a2-7c1e-7d3a-9b2c-3d4e5f607182'
const event = {} as Event

const widgetOf = (range: Parameters<typeof decorationOf>[0]) => {
  const widget = decorationOf(range).spec.widget as { ignoreEvent(e: Event): boolean } | undefined
  if (!widget) throw new Error('E_TEST_NO_WIDGET')
  return widget
}

describe('Write mode widgets under the pointer', () => {
  it('let the editor place the caret on an alert label or a note title', () => {
    expect(widgetOf({ kind: 'alert', from: 0, to: 7, alert: 'note' }).ignoreEvent(event)).toBe(
      false,
    )
    expect(widgetOf({ kind: 'noteTitle', from: 0, to: 4, id: NOTE }).ignoreEvent(event)).toBe(false)
  })

  it('keep a task checkbox to itself, so ticking it leaves the caret alone', () => {
    expect(widgetOf({ kind: 'task', from: 2, to: 5, done: false }).ignoreEvent(event)).toBe(true)
  })
})
