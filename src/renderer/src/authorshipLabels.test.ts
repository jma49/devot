import { describe, expect, it } from 'vitest'
import { writerLabel, writerLabelParts } from './authorshipLabels'

describe('writerLabelParts', () => {
  it('splits the label around the name, so the kind is never the part cut short', () => {
    const writer = { kind: 'mcp', name: 'A long client name' } as const
    expect(writerLabelParts(writer)).toEqual({
      before: '',
      name: 'A long client name',
      after: ' (MCP)',
      full: writerLabel(writer),
    })
    expect(writerLabelParts(writer, 'changed by {writer}')).toEqual({
      before: 'changed by ',
      name: 'A long client name',
      after: ' (MCP)',
      full: 'changed by A long client name (MCP)',
    })
  })

  it('keeps a writer without a name as its kind alone', () => {
    expect(writerLabelParts({ kind: 'http', name: '' }, 'changed by {writer}')).toEqual({
      before: 'changed by HTTP API',
      name: '',
      after: '',
      full: 'changed by HTTP API',
    })
  })
})
