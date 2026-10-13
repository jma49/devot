import type { Page } from '@playwright/test'
import { expect, symbolRequests, test, type TestWindow } from './fixtures'

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Format' })
const button = (page: Page, name: string) => toolbar(page).getByRole('button', { name })
const lines = (page: Page) => page.locator('.cm-line').allTextContents()

async function newNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await body(page).click()
  await page.keyboard.insertText(text)
}

type Box = { x: number; y: number; width: number; height: number }

/**
 * Double-clicks `word` on line `n` (from 1): a real mouse word selection,
 * the same on every platform (the keys that move by word differ).
 */
async function selectWord(page: Page, n: number, word: string) {
  const at = await page
    .locator('.cm-line')
    .nth(n - 1)
    .evaluate((line, target) => {
      // This config has no DOM types: only the members used here.
      const doc = (
        globalThis as unknown as {
          document: {
            createTreeWalker(root: unknown, show: number): { nextNode(): { data: string } | null }
            createRange(): {
              setStart(node: unknown, offset: number): void
              setEnd(node: unknown, offset: number): void
              getBoundingClientRect(): Box
            }
          }
        }
      ).document
      const texts = doc.createTreeWalker(line, 4 /* NodeFilter.SHOW_TEXT */)
      for (let node = texts.nextNode(); node; node = texts.nextNode()) {
        const i = node.data.indexOf(target)
        if (i < 0) continue
        const range = doc.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + target.length)
        const r = range.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }
      return null
    }, word)
  if (!at) throw new Error('E_TEST_NO_WORD')
  // A shown toolbar can cover the word (it sits beside the old selection).
  if (await toolbar(page).isVisible()) await page.keyboard.press('Escape')
  await expect(toolbar(page)).toBeHidden()
  await page.mouse.dblclick(at.x, at.y)
  await expect(toolbar(page)).toBeVisible()
  // The word itself is selected, not whatever was there before.
  const selected = page.locator('.cm-selectionBackground')
  await expect(selected).toHaveCount(1)
  await expect
    .poll(async () => {
      const box = await selected.boundingBox()
      return !!box && Math.hypot(box.x + box.width / 2 - at.x, box.y + box.height / 2 - at.y) < 3
    }, `the selection covers "${word}"`)
    .toBe(true)
}

async function selectAll(page: Page) {
  await page.keyboard.press('ControlOrMeta+a')
  await expect(toolbar(page)).toBeVisible()
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/**
 * Checks the toolbar sits just above or just below the selection, clear of
 * every selected line, and returns its box.
 */
async function expectBesideSelection(page: Page): Promise<Box> {
  await expect(toolbar(page)).toBeVisible()
  const selected = page.locator('.cm-selectionBackground')
  await expect(selected.first()).toBeVisible()
  // Wait for CodeMirror to place it (it measures in the next frame).
  await page.evaluate(
    () =>
      new Promise((done) =>
        (
          globalThis as unknown as { requestAnimationFrame(f: () => void): void }
        ).requestAnimationFrame(() => done(null)),
      ),
  )
  const bar = await toolbar(page).boundingBox()
  const boxes = await selected.evaluateAll((els) =>
    els.map((el) => {
      const r = (el as unknown as { getBoundingClientRect(): Box }).getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }),
  )
  if (!bar) throw new Error('E_TEST_NO_TOOLBAR_BOX')
  for (const box of boxes) expect(overlaps(bar, box)).toBe(false)
  const top = Math.min(...boxes.map((b) => b.y))
  const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  const gapAbove = top - (bar.y + bar.height)
  const gapBelow = bar.y - bottom
  expect(
    (gapAbove >= -1 && gapAbove < 12) || (gapBelow >= -1 && gapBelow < 12),
    `toolbar ${bar.y}-${bar.y + bar.height}, selection ${top}-${bottom}`,
  ).toBe(true)
  return bar
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('the toolbar shows for a selection, with named SF Symbol buttons', async ({ page }) => {
  await newNote(page, 'alpha beta gamma')
  await expect(toolbar(page)).toBeHidden()
  await selectAll(page)
  const names: [string, string, string][] = [
    ['Heading', 'Heading (⌘1)', 'textformat.size'],
    ['Bold', 'Bold (⌘B)', 'bold'],
    ['Italic', 'Italic (⌘I)', 'italic'],
    ['Strikethrough', 'Strikethrough (⌘U)', 'strikethrough'],
    ['Highlight', 'Highlight', 'highlighter'],
    ['Link', 'Link (⌥⌘K)', 'link'],
    ['Inline Code', 'Inline Code (⌥⌘E)', 'chevron.left.forwardslash.chevron.right'],
    ['Code Block', 'Code Block (⇧⌘C)', 'curlybraces.square'],
    ['Bulleted List', 'Bulleted List (⇧⌘L)', 'list.bullet'],
    ['Numbered List', 'Numbered List (⇧⌘O)', 'list.number'],
    ['Task List', 'Task List (⇧⌘T)', 'checklist'],
    ['Quote', "Quote (⌘')", 'text.quote'],
    ['Alert', 'Alert', 'exclamationmark.bubble'],
  ]
  await expect(toolbar(page).getByRole('button')).toHaveCount(names.length)
  for (const [name, title, symbol] of names) {
    await expect(button(page, name)).toHaveAttribute('title', title)
    await expect(button(page, name).locator('.icon')).toHaveAttribute('data-symbol', symbol)
  }
  // A separator sets the block formats apart from the inline ones.
  const order = await toolbar(page)
    .locator('> *')
    .evaluateAll((els) =>
      els.map(
        (el) =>
          (el as unknown as { getAttribute(name: string): string | null }).getAttribute(
            'aria-label',
          ) ??
          (el as unknown as { getAttribute(name: string): string | null }).getAttribute('role'),
      ),
    )
  expect(order).toEqual([
    ...names.slice(0, 7).map((n) => n[0]),
    'separator',
    ...names.slice(7).map((n) => n[0]),
  ])
  const calls = await page.evaluate(() => (globalThis as unknown as TestWindow).devotIpcCalls)
  expect(symbolRequests(calls)).toContain('bold@14')
})

test('the toolbar hides on Escape, a collapsed selection and typing', async ({ page }) => {
  await newNote(page, 'alpha beta gamma')
  await selectAll(page)
  await page.keyboard.press('Escape')
  await expect(toolbar(page)).toBeHidden()
  // Selecting again brings it back.
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(toolbar(page)).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(toolbar(page)).toBeHidden()
  await selectAll(page)
  await page.keyboard.type('x')
  await expect(toolbar(page)).toBeHidden()
  expect(await lines(page)).toEqual(['x'])
})

test('the toolbar follows the selection and never covers it', async ({ page }) => {
  await newNote(page, 'first line\nsecond line of the note\nthird line\nfourth line')
  // The first line has no room above it inside the editor: the toolbar goes below.
  await selectWord(page, 1, 'first')
  await expectBesideSelection(page)

  await selectWord(page, 3, 'third')
  const atStart = await expectBesideSelection(page)
  // The last word of the line: the toolbar moves along.
  await selectWord(page, 3, 'line')
  const atEnd = await expectBesideSelection(page)
  expect(atEnd.x).toBeGreaterThan(atStart.x + 20)

  // A selection over several lines: the toolbar sits outside all of them.
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expectBesideSelection(page)
})

test('the buttons apply and remove each format', async ({ page }) => {
  await newNote(page, 'alpha beta')
  const cases: [string, string][] = [
    ['Bold', '**alpha beta**'],
    ['Italic', '*alpha beta*'],
    ['Strikethrough', '~~alpha beta~~'],
    ['Highlight', '<mark>alpha beta</mark>'],
    ['Inline Code', '`alpha beta`'],
  ]
  for (const [name, formatted] of cases) {
    await selectAll(page)
    await expect(button(page, name)).toHaveAttribute('aria-pressed', 'false')
    await button(page, name).click()
    expect(await lines(page), name).toEqual([formatted])
    // The text stays selected, so the toolbar stays and shows the format as on.
    await expect(button(page, name)).toHaveAttribute('aria-pressed', 'true')
    await button(page, name).click()
    expect(await lines(page), name).toEqual(['alpha beta'])
  }
  // The body keeps focus: typing replaces the selection.
  await page.keyboard.type('done')
  expect(await lines(page)).toEqual(['done'])
})

test('the heading button cycles the level and the link button opens the address', async ({
  page,
}) => {
  await newNote(page, 'Plans')
  await selectAll(page)
  await button(page, 'Heading').click()
  expect(await lines(page)).toEqual(['# Plans'])
  await button(page, 'Heading').click()
  expect(await lines(page)).toEqual(['## Plans'])
  await expect(button(page, 'Heading')).toHaveAttribute('aria-pressed', 'true')

  await selectWord(page, 1, 'Plans')
  await button(page, 'Link').click()
  // The cursor waits in the empty address; the toolbar goes away.
  await expect(toolbar(page)).toBeHidden()
  await page.keyboard.insertText('https://example.com')
  expect(await lines(page)).toEqual(['## [Plans](https://example.com)'])
})

test('every format has a shortcut that works without the toolbar', async ({ page }) => {
  await newNote(page, 'word')
  const cases: [string, string][] = [
    ['ControlOrMeta+b', '**word**'],
    ['ControlOrMeta+i', '*word*'],
    ['ControlOrMeta+KeyU', '~~word~~'],
    ['ControlOrMeta+Alt+KeyE', '`word`'],
  ]
  for (const [keys, formatted] of cases) {
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Escape')
    await expect(toolbar(page)).toBeHidden()
    await page.keyboard.press(keys)
    expect(await lines(page), keys).toEqual([formatted])
    await page.keyboard.press(keys)
    expect(await lines(page), keys).toEqual(['word'])
  }
  for (const level of [1, 2, 3, 4, 5, 6]) {
    await page.keyboard.press(`${level <= 4 ? 'ControlOrMeta' : 'ControlOrMeta+Alt'}+Digit${level}`)
    expect(await lines(page)).toEqual([`${'#'.repeat(level)} word`])
  }
  await page.keyboard.press('ControlOrMeta+Alt+Digit6')
  expect(await lines(page)).toEqual(['word'])

  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+Alt+k')
  await page.keyboard.insertText('u')
  expect(await lines(page)).toEqual(['[word](u)'])
})

test('a multi-line selection formats each line', async ({ page }) => {
  await newNote(page, '- one\n- two\n\n- three')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+b')
  expect(await lines(page)).toEqual(['- **one**', '- **two**', '', '- **three**'])
  await page.keyboard.press('ControlOrMeta+b')
  expect(await lines(page)).toEqual(['- one', '- two', '', '- three'])
})

test('each format is one undo step', async ({ page }) => {
  await newNote(page, 'alpha beta')
  await selectAll(page)
  await button(page, 'Bold').click()
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  expect(await lines(page)).toEqual(['**alpha beta**!'])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['**alpha beta**'])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['alpha beta'])

  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+Digit2')
  expect(await lines(page)).toEqual(['## alpha beta'])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['alpha beta'])
})

test('Edit > Undo also takes back one format at a time', async ({ page }) => {
  await newNote(page, 'alpha beta')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+i')
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  // The menu item reaches the page as a `historyUndo` input event, which
  // CodeMirror's history handles (it comes before the Yjs binding); format
  // transactions isolate their history, so each one is its own step.
  const menuUndo = () =>
    body(page).evaluate((el) => {
      const Input = (globalThis as unknown as { InputEvent: new (t: string, o: object) => unknown })
        .InputEvent
      ;(el as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(
        new Input('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true }),
      )
    })
  await menuUndo()
  await expect.poll(() => lines(page)).toEqual(['*alpha beta*'])
  await menuUndo()
  await expect.poll(() => lines(page)).toEqual(['alpha beta'])
})

test('bold next to punctuation keeps it outside the markers and toggles off again', async ({
  page,
}) => {
  // Ideographs and an ideographic full stop, built from code points.
  const [x, y, stop] = [0x4e2d, 0x6587, 0x3002].map((c) => String.fromCodePoint(c))
  await newNote(page, `${x}${x}${y}${y}${stop}${x}${x}`)
  // The text before the last two ideographs: the cursor sits after the stop.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft')
  await expect(toolbar(page)).toBeVisible()
  await page.keyboard.press('ControlOrMeta+KeyB')
  expect(await lines(page)).toEqual([`${x}${x}**${y}${y}**${stop}${x}${x}`])
  // The toolbar shows the selection as bold.
  await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'true')
  // The same key again takes it off, not a second pair on.
  await page.keyboard.press('ControlOrMeta+KeyB')
  expect(await lines(page)).toEqual([`${x}${x}${y}${y}${stop}${x}${x}`])
})
