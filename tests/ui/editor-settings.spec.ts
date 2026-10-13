import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test, type TestWindow } from './fixtures'

// Editor settings in the main window. Rust keeps them and, after every
// change, sends `devot://editor-settings-changed` to every window; the page
// re-sends it as `devot:editor-settings-changed`, which these tests send to
// stand in for a change made in the Settings window. Changes apply to the open editor at
// once, without rebuilding it.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const content = (page: Page) => page.locator('.cm-content')
const scroller = (page: Page) => page.locator('.cm-scroller')
/** A line's exact text (toHaveText would collapse its indent). */
const lineText = (page: Page, n: number) =>
  page
    .locator('.cm-line')
    .nth(n)
    .evaluate((el) => el.textContent)

async function newNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await body(page).click()
  await page.keyboard.insertText(text)
}

/** What Rust would send to every window after a change made elsewhere. */
const changed = changeEditorSettingsElsewhere

const setCalls = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as TestWindow).devotIpcCalls
      .filter((c) => c.cmd === 'editor_settings_set')
      .map((c) => c.args['patch']),
  )

/** Marks the editor's element, to tell later whether it was rebuilt. */
const markEditor = (page: Page) =>
  page
    .locator('.cm-editor')
    .evaluate(
      (el) => ((el as unknown as { dataset: Record<string, string> }).dataset['probe'] = '1'),
    )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('the editor starts with the stored settings', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotEditorRevision = 4
    w.devotEditorSettings = { lineNumbers: false, fontSize: 17, spellCheck: true }
  })
  await page.reload()
  await newNote(page, 'alpha')
  await expect(page.locator('.cm-lineNumbers')).toHaveCount(0)
  await expect(content(page)).toHaveCSS('font-size', '17px')
  await expect(content(page)).toHaveAttribute('spellcheck', 'true')
})

test('the defaults keep the editor as it was', async ({ page }) => {
  await newNote(page, 'alpha\n\tbeta')
  await expect(page.locator('.cm-lineNumbers')).toHaveCount(1)
  await expect(page.locator('.cm-activeLine')).toHaveCount(1)
  await expect(content(page)).toHaveClass(/cm-lineWrapping/)
  await expect(content(page)).toHaveCSS('font-size', '13px')
  await expect(content(page)).toHaveAttribute('spellcheck', 'false')
  await expect(content(page)).toHaveCSS('max-width', 'none')
  await expect(content(page)).toHaveCSS('tab-size', '4')
  await expect(scroller(page)).toHaveCSS('font-family', /SF Mono|ui-monospace|Menlo|monospace/)
})

test('a change from another window applies to the open editor at once', async ({ page }) => {
  await newNote(page, 'alpha\n\tbeta')
  await markEditor(page)
  await changed(page, {
    lineNumbers: false,
    lineWrapping: false,
    readableWidth: true,
    fontSize: 20,
    fontFamily: 'menlo',
    lineHeight: 2,
    indentUnit: 'tab',
    tabWidth: 8,
    listMarker: '*',
    spellCheck: true,
    highlightActiveLine: false,
  })
  await expect(page.locator('.cm-gutters')).toHaveCount(0)
  await expect(page.locator('.cm-activeLine')).toHaveCount(0)
  await expect(content(page)).not.toHaveClass(/cm-lineWrapping/)
  // Only wrapped lines keep to the readable width.
  await expect(content(page)).toHaveCSS('max-width', 'none')
  await expect(content(page)).toHaveCSS('font-size', '20px')
  await expect(scroller(page)).toHaveCSS('font-family', /^Menlo/)
  await expect(scroller(page)).toHaveCSS('line-height', '40px')
  await expect(content(page)).toHaveCSS('tab-size', '8')
  await expect(content(page)).toHaveAttribute('spellcheck', 'true')
  // The same editor, reconfigured, with the text and the keyboard focus kept.
  await expect(page.locator('.cm-editor')).toHaveAttribute('data-probe', '1')
  await expect(body(page)).toBeFocused()
  await expect(body(page)).toContainText('alpha')

  await changed(page, { readableWidth: true })
  await expect(content(page)).toHaveCSS('max-width', '720px')
  await expect(page.locator('.cm-editor')).toHaveAttribute('data-probe', '1')

  // And back.
  await changed(page, {})
  await expect(page.locator('.cm-lineNumbers')).toHaveCount(1)
  await expect(page.locator('.cm-activeLine')).toHaveCount(1)
  await expect(content(page)).toHaveClass(/cm-lineWrapping/)
  await expect(content(page)).toHaveCSS('max-width', 'none')
  await expect(content(page)).toHaveCSS('font-size', '13px')
  await expect(content(page)).toHaveAttribute('spellcheck', 'false')
  await expect(page.locator('.cm-editor')).toHaveAttribute('data-probe', '1')
})

test('new list items take the list marker, and indenting takes the indent unit', async ({
  page,
}) => {
  await changed(page, { listMarker: '*', indentUnit: 'tab' })
  await newNote(page, 'alpha')
  await page.keyboard.press('ControlOrMeta+Shift+Digit8')
  await expect.poll(() => lineText(page, 0)).toBe('* alpha')
  await page.keyboard.press('Tab')
  await expect.poll(() => lineText(page, 0)).toBe('\t* alpha')

  // A line that becomes an item later takes the marker set then.
  await changed(page, { listMarker: '-', indentUnit: 'spaces4' })
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\n\nbeta')
  await page.keyboard.press('ControlOrMeta+Shift+Digit8')
  await expect.poll(() => lineText(page, 2)).toBe('- beta')
  await page.keyboard.press('Tab')
  await expect.poll(() => lineText(page, 2)).toBe('    - beta')
})

test('Cmd+= and Cmd+- change the font size, and Cmd+0 resets it', async ({ page }) => {
  await newNote(page, 'alpha')
  await markEditor(page)
  await page.keyboard.press('Meta+Equal')
  await expect(content(page)).toHaveCSS('font-size', '14px')
  await page.keyboard.press('Meta+Shift+Equal')
  await expect(content(page)).toHaveCSS('font-size', '15px')
  await page.keyboard.press('Meta+Minus')
  await expect(content(page)).toHaveCSS('font-size', '14px')
  await page.keyboard.press('Meta+Digit0')
  await expect(content(page)).toHaveCSS('font-size', '13px')
  expect(await setCalls(page)).toEqual([
    { fontSize: 14 },
    { fontSize: 15 },
    { fontSize: 14 },
    { fontSize: 13 },
  ])
  // Typing still goes to the same editor.
  await expect(page.locator('.cm-editor')).toHaveAttribute('data-probe', '1')
  await page.keyboard.type('!')
  await expect(body(page)).toContainText('alpha!')
})

/**
 * Makes `editor_settings_set` hold its answers: each call stores the change
 * as Rust would and waits in `devotHeld` until `release` answers it. The
 * event Rust sends every window waits too, until `announce` sends it.
 */
const holdAnswers = (page: Page) =>
  page.evaluate(() => {
    const w = globalThis as unknown as TestWindow & {
      devotHeld: { answer: () => void; event: () => void }[]
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string, init: { detail: unknown }) => unknown
    }
    w.devotHeld = []
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      editor_settings_set: (args: { patch: object }) => {
        w.devotEditorSettings = { ...w.devotEditorSettings, ...args.patch }
        w.devotEditorRevision = (w.devotEditorRevision ?? 0) + 1
        const next = { revision: w.devotEditorRevision, settings: w.devotEditorSettings }
        return new Promise((resolve) => {
          w.devotHeld.push({
            answer: () => resolve(next),
            event: () =>
              w.dispatchEvent(new w.CustomEvent('devot:editor-settings-changed', { detail: next })),
          })
        })
      },
    }
  })

/** Answers the `n`th held change (from 1). */
const release = (page: Page, n: number) =>
  page.evaluate((i) => {
    ;(globalThis as unknown as { devotHeld: { answer: () => void }[] }).devotHeld[i]!.answer()
  }, n - 1)

/** Sends the event for the `n`th held change (from 1). */
const announce = (page: Page, n: number) =>
  page.evaluate((i) => {
    ;(globalThis as unknown as { devotHeld: { event: () => void }[] }).devotHeld[i]!.event()
  }, n - 1)

/** The editor's font size right now (no waiting for it to become something). */
const fontSizeNow = (page: Page) =>
  content(page).evaluate(
    (el) =>
      (
        globalThis as unknown as { getComputedStyle(e: unknown): { fontSize: string } }
      ).getComputedStyle(el).fontSize,
  )

test('quick presses all count, whatever order the answers come in', async ({ page }) => {
  await newNote(page, 'alpha')
  await holdAnswers(page)
  // Three presses before any answer: each steps from the size shown.
  await page.keyboard.press('Meta+Equal')
  await page.keyboard.press('Meta+Equal')
  await page.keyboard.press('Meta+Equal')
  expect(await fontSizeNow(page)).toBe('16px')
  // Changes go one at a time, in order.
  expect(await setCalls(page)).toEqual([{ fontSize: 14 }])

  // The first answer arrives before its event; the size shown stays.
  await release(page, 1)
  await expect.poll(() => setCalls(page)).toEqual([{ fontSize: 14 }, { fontSize: 15 }])
  expect(await fontSizeNow(page)).toBe('16px')
  await release(page, 2)
  await expect
    .poll(() => setCalls(page))
    .toEqual([{ fontSize: 14 }, { fontSize: 15 }, { fontSize: 16 }])
  expect(await fontSizeNow(page)).toBe('16px')
  // The last event arrives before its answer, then the older events, last first.
  await announce(page, 3)
  expect(await fontSizeNow(page)).toBe('16px')
  await release(page, 3)
  expect(await fontSizeNow(page)).toBe('16px')
  await announce(page, 2)
  expect(await fontSizeNow(page)).toBe('16px')
  await announce(page, 1)
  expect(await fontSizeNow(page)).toBe('16px')
  await page.waitForTimeout(200)
  expect(await fontSizeNow(page)).toBe('16px')
  expect(await setCalls(page)).toHaveLength(3)
})

test('an answer older than a change made elsewhere changes nothing', async ({ page }) => {
  await newNote(page, 'alpha')
  await holdAnswers(page)
  await page.keyboard.press('Meta+Equal')
  await expect.poll(() => setCalls(page)).toEqual([{ fontSize: 14 }])
  expect(await fontSizeNow(page)).toBe('14px')
  // Another window stores a size after this change was stored (revision 2).
  await changed(page, { fontSize: 20 })
  expect(await fontSizeNow(page)).toBe('14px')
  // This window's answer (revision 1) arrives late: the newer size stays.
  await release(page, 1)
  await expect(content(page)).toHaveCSS('font-size', '20px')
  await announce(page, 1)
  await page.waitForTimeout(200)
  expect(await fontSizeNow(page)).toBe('20px')
})

test('the font size stops at its limits', async ({ page }) => {
  await changed(page, { fontSize: 32 })
  await newNote(page, 'alpha')
  await page.keyboard.press('Meta+Equal')
  await expect(content(page)).toHaveCSS('font-size', '32px')
  expect(await setCalls(page)).toEqual([])
  await changed(page, { fontSize: 10 })
  await page.keyboard.press('Meta+Minus')
  await expect(content(page)).toHaveCSS('font-size', '10px')
  expect(await setCalls(page)).toEqual([])
})

test('the font size commands are in the command palette', async ({ page }) => {
  await page.keyboard.press('Meta+KeyP')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('font size')
  await expect(palette.getByRole('option', { name: /Increase Font Size/ })).toContainText('⌘=')
  await expect(palette.getByRole('option', { name: /Decrease Font Size/ })).toContainText('⌘-')
  await palette.getByRole('option', { name: /Increase Font Size/ }).click()
  await expect.poll(() => setCalls(page)).toEqual([{ fontSize: 14 }])
})
