// A long note of prose, lists, tables and code blocks: one section of each, repeated to `chars` characters.
export function longNote(chars: number): string {
  const sections: string[] = []
  for (let i = 0, length = 0; length < chars; i++) {
    const section = [
      `## Section ${i}`,
      '',
      'A paragraph of prose with **bold**, *emphasis*, `code`, a [link](https://example.com) and enough words to wrap at the width of the editor.',
      '',
      '- one item',
      '- two items',
      '  - [ ] a nested task',
      '1. ordered',
      '',
      '| Name | Price |',
      '| --- | ---: |',
      '| apple | 1 |',
      '',
      ...(i % 2 === 0
        ? [
            '```ts',
            'export const total = (items: number[]) => items.reduce((a, b) => a + b, 0)',
            '```',
          ]
        : ['```python', 'def total(items):', '    return sum(items)', '```']),
      '',
      '> A quote with [[Another note]].',
      '',
    ].join('\n')
    sections.push(section)
    length += section.length
  }
  return sections.join('')
}
