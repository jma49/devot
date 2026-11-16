import { expect, type Locator } from '@playwright/test'

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

// A role query reads every element's accessible name on each poll: on a 600 KB preview its polls took
// most of a minute and held up the build they waited for (issue 928), where the build alone takes seconds.
export async function waitForLastSection(preview: Locator, text: string): Promise<void> {
  const last = text
    .match(/^## Section \d+$/gm)!
    .at(-1)!
    .slice(3)
  await expect(preview.locator('h2').last()).toHaveText(last, { timeout: 60_000 })
}
