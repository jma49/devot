import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Front matter at the start of a note reads as metadata in the editor, not
// as a heading; a `---` further down still makes a heading or a rule.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const line = (page: Page, n: number) => page.locator('.cm-line').nth(n)

async function newNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await body(page).click()
  await page.keyboard.insertText(text)
}

// The page's DOM, which the Node types of the test files do not describe.
interface Dom {
  getComputedStyle(element: unknown): {
    fontWeight: string
    textDecorationLine: string
    color: string
  }
  document: {
    body: { append(node: unknown): void }
    createElement(tag: string): { style: { color: string }; remove(): void }
  }
}

/** How the text of a line is drawn: the heaviest weight, any underline, and its colours. */
function lineStyle(locator: Locator) {
  return locator.evaluate((el) => {
    const dom = globalThis as unknown as Dom
    const parts = [el, ...el.querySelectorAll('*')].filter((e) => e.textContent?.trim())
    const styles = parts.map((e) => dom.getComputedStyle(e))
    return {
      weight: Math.max(...styles.map((s) => Number(s.fontWeight))),
      underline: styles.some((s) => s.textDecorationLine.includes('underline')),
      colors: [...new Set(styles.slice(1).map((s) => s.color))],
    }
  })
}

/** The colour a token variable resolves to. */
function tokenColor(page: Page, name: string) {
  return page.evaluate((variable) => {
    const dom = globalThis as unknown as Dom
    const probe = dom.document.createElement('span')
    probe.style.color = `var(${variable})`
    dom.document.body.append(probe)
    const color = dom.getComputedStyle(probe).color
    probe.remove()
    return color
  }, name)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('front matter is styled as metadata, a later setext heading as a heading', async ({
  page,
}) => {
  await newNote(page, '---\ntitle: Launch plan\nauthor: me\n---\n\nTitle\n---\n\nText')
  await expect(line(page, 8)).toHaveText('Text')

  const secondary = await tokenColor(page, '--color-text-secondary')
  const tertiary = await tokenColor(page, '--color-text-tertiary')
  // The parser may finish after the text is in, so each style is polled.
  for (const n of [1, 2])
    await expect
      .poll(() => lineStyle(line(page, n)), { message: `line ${n}` })
      .toEqual({ weight: 400, underline: false, colors: [secondary] })
  // The fences are metadata too, in the tertiary colour.
  for (const n of [0, 3])
    await expect
      .poll(() => lineStyle(line(page, n)), { message: `line ${n}` })
      .toEqual({ weight: 400, underline: false, colors: [tertiary] })
  // The paragraph over the later `---` is still a heading: bold, and not
  // underlined, which is for links.
  await expect.poll(() => lineStyle(line(page, 5))).toMatchObject({ weight: 700, underline: false })
})

test('front matter becomes a heading again when its first fence goes', async ({ page }) => {
  await newNote(page, '---\ntitle: Launch plan\n---\n')
  await expect.poll(async () => (await lineStyle(line(page, 1))).weight).toBe(400)
  // Remove the opening fence: the key line and the closing `---` make a setext heading.
  await line(page, 0).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Delete')
  await expect(line(page, 0)).toHaveText('title: Launch plan')
  await expect.poll(async () => (await lineStyle(line(page, 0))).weight).toBe(700)
})

/** Pastes plain text into the editor, as the system would. */
async function paste(page: Page, text: string) {
  await body(page).evaluate((el, value) => {
    // This config has no DOM types: the few browser classes used here.
    const w = globalThis as unknown as {
      DataTransfer: new () => { setData(type: string, value: string): void }
      ClipboardEvent: new (type: string, init: object) => unknown
    }
    const data = new w.DataTransfer()
    data.setData('text/plain', value)
    const init = { bubbles: true, cancelable: true, clipboardData: data }
    ;(el as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(
      new w.ClipboardEvent('paste', init),
    )
  }, text)
}

/** Selects the text of a line, from its end back to its start. */
async function selectLine(page: Page, n: number) {
  await line(page, n).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
}

test('a URL pasted over front matter replaces the text; over body text it makes a link', async ({
  page,
}) => {
  await newNote(page, '---\nsource: old\n---\n\nword')
  await expect(line(page, 4)).toHaveText('word')
  await selectLine(page, 1)
  await paste(page, 'https://new.example')
  await expect(line(page, 1)).toHaveText('https://new.example')
  await selectLine(page, 4)
  await paste(page, 'https://new.example')
  await expect(line(page, 4)).toHaveText('[word](https://new.example)')
})
