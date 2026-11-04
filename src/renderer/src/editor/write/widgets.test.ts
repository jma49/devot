import type { ElementContent, Element } from 'hast'
import { describe, expect, it } from 'vitest'
import { paragraphContent } from './inline'
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
    expect(widgetOf({ kind: 'inline', from: 0, to: 6, source: ':tada:' }).ignoreEvent(event)).toBe(
      false,
    )
  })

  it('keep a task checkbox to itself, so ticking it leaves the caret alone', () => {
    expect(widgetOf({ kind: 'task', from: 0, to: 5, box: 2, done: false }).ignoreEvent(event)).toBe(
      true,
    )
  })
})

describe("Write mode's inline elements from the preview's renderers", () => {
  const text = (value: string): ElementContent => ({ type: 'text', value })
  const element = (tagName: string, children: ElementContent[]): Element => ({
    type: 'element',
    tagName,
    properties: {},
    children,
  })

  it('take the content of the one paragraph the element renders as', () => {
    const kbd = element('kbd', [text('A')])
    expect(paragraphContent([element('p', [kbd])])).toEqual([kbd])
  })

  it('take nothing from a render that is not one paragraph', () => {
    expect(paragraphContent([])).toBeNull()
    expect(paragraphContent([element('pre', [text('x')])])).toBeNull()
    expect(paragraphContent([element('p', []), element('p', [])])).toBeNull()
  })
})
