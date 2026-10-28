import { describe, expect, it } from 'vitest'
import { diagramName, isFrameMessage, labelDiagram } from './mermaid-protocol'

describe('isFrameMessage', () => {
  it('accepts a drawing and a failure with its reason', () => {
    expect(isFrameMessage({ type: 'rendered', id: 1, svg: '<svg/>' })).toBe(true)
    expect(isFrameMessage({ type: 'failed', id: 2, reason: 'parse' })).toBe(true)
    expect(isFrameMessage({ type: 'failed', id: 3, reason: 'render' })).toBe(true)
    expect(isFrameMessage({ type: 'failed', id: 8, reason: 'layout' })).toBe(true)
  })

  it('refuses a failure without a reason the frame can give', () => {
    expect(isFrameMessage({ type: 'failed', id: 4 })).toBe(false)
    expect(isFrameMessage({ type: 'failed', id: 5, reason: 'timeout' })).toBe(false)
    expect(isFrameMessage({ type: 'failed', id: 6, reason: 'other' })).toBe(false)
    expect(isFrameMessage({ type: 'rendered', id: 7 })).toBe(false)
    expect(isFrameMessage({ type: 'rendered', id: 1.5, svg: '' })).toBe(false)
  })
})

describe('diagramName', () => {
  it('reads an accessible title, a front matter title and a title line', () => {
    expect(diagramName('flowchart TD\n  accTitle: Release steps\n  A --> B')).toBe('Release steps')
    expect(diagramName('---\ntitle: Signup flow\n---\nflowchart LR\n  A --> B')).toBe('Signup flow')
    expect(diagramName('pie title Pets\n  "Dogs" : 3')).toBe('Pets')
    expect(diagramName('gantt\n  title: Plan\n  section A')).toBe('Plan')
  })

  it('prefers the accessible title and has none for an untitled diagram', () => {
    expect(diagramName('---\ntitle: Front\n---\nflowchart TD\n accTitle: Acc\n A --> B')).toBe(
      'Acc',
    )
    expect(diagramName('flowchart TD\n  A --> B')).toBeNull()
    expect(diagramName('flowchart TD\n  titled --> B')).toBeNull()
  })

  it('cuts a very long name', () => {
    expect(diagramName(`flowchart TD\n  accTitle: ${'x'.repeat(500)}`)?.length).toBe(120)
  })
})

describe('diagramName false positives', () => {
  it('does not take a node called title for the diagram name', () => {
    expect(diagramName('flowchart TD\n  title --> B')).toBeNull()
    expect(diagramName('mindmap\n  root\n    title Foo')).toBeNull()
    expect(diagramName('stateDiagram-v2\n  title --> done')).toBeNull()
    expect(diagramName('classDiagram\n  class title')).toBeNull()
  })

  it('reads a title in a diagram type that has the keyword, after a directive', () => {
    expect(diagramName('%%{init: {}}%%\ntimeline\n  title History')).toBe('History')
    expect(diagramName('journey\n  title My day')).toBe('My day')
  })
})

describe('labelDiagram', () => {
  it('names the drawing once, dropping the labelledby that would override it', () => {
    const attrs = new Map([['aria-labelledby', 'chart-title']])
    labelDiagram(
      {
        setAttribute: (n, v) => void attrs.set(n, v),
        removeAttribute: (n) => void attrs.delete(n),
      },
      'Diagram: Plan',
    )
    expect(attrs.get('aria-label')).toBe('Diagram: Plan')
    expect(attrs.get('role')).toBe('img')
    expect(attrs.has('aria-labelledby')).toBe(false)
  })
})
