import type { Page } from '@playwright/test'
import { CHUNK_BLOCKS, CHUNK_CLASS } from '../../src/renderer/src/preview/chunks'
import { expectWithinBudget, setOverloadProbe } from '../support/budget'
import { machineOverloaded } from '../support/machine-load'
import { expect, openApp, test } from './fixtures'
import type { ViewLike } from './keystrokes'
import { mainThreadSeconds, quietProcess, webProcessOf } from './webProcess'

// Typing at the top of a big note in Split view: the web process's main-thread CPU for 40 keys.
// WebKit repaints a layer's event region after every paint in it, and the page's wheel listeners make
// that pass walk every block of the layer. With the whole preview on one layer, these keys took about
// 2 s of a developer's Mac, half of it in that pass; with the blocks in chunks on layers of their own,
// about 0.9 s (issue 727). That pass is WebKit's macOS path, so the CPU check runs on macOS only and
// the chunk test holds the layers everywhere. Locally an overloaded machine skips (budget.ts).
const MAIN_THREAD_BUDGET_MS = 1300
const NOTE_CHARS = 250_000
const KEYS = 'abcdefghij'.repeat(4)

setOverloadProbe(machineOverloaded)

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })

const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'.split(
  ' ',
)
const phrase = (i: number, count: number) =>
  Array.from({ length: count }, (_, at) => words[(i * 7 + at * 3) % words.length]).join(' ')

function section(i: number): string {
  const rows = Array.from(
    { length: 8 },
    (_, row) =>
      `| item ${i}-${row} | ${(i * 31 + row * 17) % 1000} | Active | ${phrase(i + row, 4)}. |`,
  )
  return [
    `## Section ${i}`,
    '',
    `${phrase(i, 14)} ~~ut~~ elit. [Ullamco](https://example.com/${i}) sit <mark>magna</mark> ${phrase(i + 1, 30)}.`,
    '',
    `\u4eca\u5929\u6211\u4eec\u5728\u8fd9\u91cc\u8bb0\u5f55\u4e00\u4e9b\u60f3\u6cd5\u3002 ${phrase(i + 2, 12)} \`ad\` ${phrase(i + 3, 4)}.`,
    '',
    `### Lists ${i}`,
    '',
    `- ${phrase(i, 6)}.`,
    `- ${phrase(i + 1, 5)} \`amet\` ut.`,
    `- ${phrase(i + 2, 6)}.`,
    `  - ~~Enim~~ ${phrase(i + 3, 4)}.`,
    `  - ${phrase(i + 4, 5)}.`,
    '',
    `1. ${phrase(i + 5, 6)} [ipsum](https://example.com/2).`,
    `2. ${phrase(i + 6, 6)}.`,
    `3. ${phrase(i + 7, 6)}.`,
    '',
    `- [ ] ${phrase(i, 5)}.`,
    `- [x] ${phrase(i + 1, 5)} **tempor**.`,
    `- [ ] ${phrase(i + 2, 5)} \`laboris\`.`,
    `- [x] ${phrase(i + 3, 5)}.`,
    '',
    '> [!TIP]',
    `> ${phrase(i + 4, 14)} \`tempor\` ${phrase(i + 5, 4)}.`,
    '',
    '| Name | Count | Status | Note |',
    '| :--- | :---: | ---: | --- |',
    ...rows,
    '',
    '```ts',
    `export function f${i}(x: number): number {`,
    '  const y = x * 2 // comment',
    `  return y + ${i}`,
    '}',
    '```',
    '',
    '```python',
    `def g${i}(n):`,
    '    return [i * i for i in range(n)]',
    '```',
    '',
    `Inline math $a_${i}^2 + b^2 = c^2$ and keys.`,
    '',
    '$$',
    `\\sum_{i=1}^{${i}} i = \\frac{${i}(${i}+1)}{2}`,
    '$$',
    '',
    'Emoji :tada: :sparkles: and keys <kbd>Cmd</kbd>, x<sup>2</sup>, H<sub>2</sub>O.',
    '',
    '---',
    '',
    '',
  ].join('\n')
}

function corpusNote(chars: number): { text: string; sections: number } {
  const parts = ['# Big rich note\n\n']
  let i = 1
  for (let length = 0; length < chars; i++) {
    const next = section(i)
    parts.push(next)
    length += next.length
  }
  return { text: parts.join(''), sections: i - 1 }
}

async function openInSplit(page: Page, note: { text: string; sections: number }): Promise<void> {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await body(page).click()
  await page.keyboard.insertText('x')
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split', exact: true })
    .click()
  await body(page).evaluate((el, text) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    })
  }, note.text)
  await expect(preview(page).locator('h2')).toHaveCount(note.sections, {
    timeout: 60_000,
  })
}

test('the preview of a big note puts its blocks in chunks, each on a layer of its own', async ({
  page,
}) => {
  await openInSplit(page, corpusNote(60_000))
  const chunks = await preview(page)
    .locator('.preview-body')
    .evaluate(
      (host, chunkClass) =>
        [...host.children]
          .filter((el) => !el.hasAttribute('data-devot-ui'))
          .map((el) => ({
            chunk: el.classList.contains(chunkClass),
            willChange: getComputedStyle(el).willChange,
            blocks: el.childElementCount,
          })),
      CHUNK_CLASS,
    )
  expect(chunks.length).toBeGreaterThan(3)
  for (const chunk of chunks) {
    expect(chunk.chunk).toBe(true)
    expect(chunk.willChange).toBe('transform')
    expect(chunk.blocks).toBeGreaterThan(0)
    expect(chunk.blocks).toBeLessThanOrEqual(2 * CHUNK_BLOCKS)
  }
})

test('typing at the top of a 250 KB note in Split view keeps the main thread within its budget', async ({
  page,
}) => {
  test.skip(process.platform !== 'darwin', "WebKit's event-region pass runs on macOS only")
  test.setTimeout(300_000)
  await openInSplit(page, corpusNote(NOTE_CHARS))
  const pid = await webProcessOf(page)
  if (pid === undefined) {
    test.skip(
      true,
      'E_TEST_WEB_PROCESS: the page was not the only web process busy while it burned',
    )
    return
  }
  await quietProcess(pid)
  await body(page).evaluate((el) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    const text = view.state.doc.toString()
    const at = text.indexOf('\n\n', text.indexOf('## Section 1\n')) + 2
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
    view.focus()
  })
  await quietProcess(pid)

  const before = mainThreadSeconds(pid)
  await page.keyboard.type(KEYS)
  await expect(preview(page)).toContainText(KEYS, { timeout: 60_000 })
  await quietProcess(pid, 90_000)
  const spent = (mainThreadSeconds(pid) - before) * 1000

  console.log(`main thread for ${KEYS.length} keys at the top: ${spent.toFixed(0)} ms`)
  expectWithinBudget({ skip: (why) => test.skip(true, why) }, spent, MAIN_THREAD_BUDGET_MS)
})
