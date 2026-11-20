import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { asBlockAt } from './attachContent'

const doc = (text: string) => Text.of(text.split('\n'))

describe('asBlockAt', () => {
  it('puts the images on lines of their own in the middle of a line', () => {
    expect(asBlockAt(doc('Before after'), 7, '![scan](x)')).toBe('\n![scan](x)\n')
  })

  it('adds no break at the start or end of the note, or beside one already there', () => {
    expect(asBlockAt(doc(''), 0, '![scan](x)')).toBe('![scan](x)')
    expect(asBlockAt(doc('Line'), 4, '![scan](x)')).toBe('\n![scan](x)')
    expect(asBlockAt(doc('Line\nNext'), 5, '![scan](x)')).toBe('![scan](x)\n')
    expect(asBlockAt(doc('Line\n\nNext'), 5, '![scan](x)')).toBe('![scan](x)')
  })
})
