import type { Page } from '@playwright/test'
import { expect, test, type TestWindow } from './fixtures'

// The Format menu in the menu bar (src-tauri/src/format_menu.rs): its keys
// come from the command registry and are live only while the editor has
// the keyboard; a picked item (`devot://format`, re-sent in the page as
// `devot:format`) formats the editor's selection.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const title = (page: Page) => page.getByRole('textbox', { name: 'Title' })

async function newNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(title(page)).toHaveValue('')
  await body(page).click()
  await page.keyboard.insertText(text)
  await expect(body(page)).toHaveText(text)
}

/** What a Format menu item sends to the page, with its command ID. */
const pick = (page: Page, id: unknown) =>
  page.evaluate((detail) => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (type: string, init: { detail: unknown }) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:format', { detail }))
  }, id)

/**
 * The key and, at once, the menu item with that key, in one task: the menu
 * item counts as an echo of the key only within a short window, which two
 * round trips to the page could outlast on a loaded machine.
 */
const keyThenPick = (page: Page, code: string, id: string) =>
  page.evaluate(
    ([keyCode, detail, key]) => {
      const w = globalThis as unknown as {
        document: { activeElement: unknown; body: unknown }
        navigator: { platform: string }
        dispatchEvent(e: unknown): void
        CustomEvent: new (type: string, init: { detail: unknown }) => unknown
        KeyboardEvent: new (type: string, init: Record<string, unknown>) => unknown
      }
      const mac = /Mac/.test(w.navigator.platform)
      const target = (w.document.activeElement ?? w.document.body) as {
        dispatchEvent(e: unknown): void
      }
      target.dispatchEvent(
        new w.KeyboardEvent('keydown', {
          key,
          code: keyCode,
          metaKey: mac,
          ctrlKey: !mac,
          bubbles: true,
          cancelable: true,
        }),
      )
      w.dispatchEvent(new w.CustomEvent('devot:format', { detail }))
    },
    [code, id, 'i'] as const,
  )

/** The Format menu state the UI asked Rust for, oldest first. */
const menuStates = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as TestWindow).devotIpcCalls
      .filter((c) => c.cmd === 'format_menu_set')
      .map((c) => c.args as { enabled: boolean; keys: Record<string, string> }),
  )

const lastMenuState = async (page: Page) => (await menuStates(page)).at(-1)

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('the Format menu has its keys while the editor has the keyboard', async ({ page }) => {
  await expect.poll(() => lastMenuState(page)).toEqual({ enabled: false, keys: {} })
  await newNote(page, 'word')
  // On the empty line Strikethrough did nothing, so its key waited.
  await expect
    .poll(async () => (await lastMenuState(page))?.keys['format.strikethrough'])
    .toBe('CmdOrCtrl+U')
  const { keys } = (await lastMenuState(page))!
  expect(keys['format.italic']).toBe('CmdOrCtrl+I')
  expect(keys['format.strikethrough']).toBe('CmdOrCtrl+U')
  expect(keys['format.heading1']).toBe('CmdOrCtrl+1')
  expect(keys['format.alertNote']).toBeUndefined()

  // Elsewhere the keys are the window's again (Cmd+K opens the palette).
  await title(page).click()
  await expect.poll(() => lastMenuState(page)).toEqual({ enabled: false, keys: {} })
  await body(page).click()
  await expect.poll(() => lastMenuState(page)).toMatchObject({ enabled: true })
  // Another window (Settings) taking the keyboard turns the menu off too.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      Event: new (type: string) => unknown
    }
    w.dispatchEvent(new w.Event('blur'))
  })
  await expect.poll(() => lastMenuState(page)).toEqual({ enabled: false, keys: {} })
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      Event: new (type: string) => unknown
    }
    w.dispatchEvent(new w.Event('focus'))
  })
  await expect.poll(() => lastMenuState(page)).toMatchObject({ enabled: true })
  // Only changes are sent, not every focus move inside the editor.
  const count = (await menuStates(page)).length
  await page.keyboard.press('Shift+Home')
  await body(page).click()
  await page.waitForTimeout(100)
  expect(await menuStates(page)).toHaveLength(count)
})

test('a picked Format menu item formats the selection once', async ({ page }) => {
  await newNote(page, 'word')
  await page.keyboard.press('Shift+Home')
  await pick(page, 'format.italic')
  await expect(body(page)).toHaveText('*word*')
  await pick(page, 'format.italic')
  await expect(body(page)).toHaveText('word')
  // Items without keys work too.
  await pick(page, 'format.heading2')
  await expect(body(page)).toHaveText('## word')
  await pick(page, 'format.alertTip')
  await expect(page.locator('.cm-line')).toHaveText(['> [!TIP]', '> ## word'])
})

test('a format key is offered only where the format does something', async ({ page }) => {
  await newNote(page, 'plain')
  await expect
    .poll(async () => (await lastMenuState(page))?.keys['format.italic'])
    .toBe('CmdOrCtrl+I')
  // In code the inline formats do nothing: their keys are left to the editor
  // (Cmd+I selects the parent syntax there, which the menu would have eaten).
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('```')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('code')
  await expect.poll(async () => (await lastMenuState(page))?.keys['format.italic']).toBeUndefined()
  const keys = (await lastMenuState(page))!.keys
  expect(keys['format.bold']).toBeUndefined()
  expect(keys['format.link']).toBeUndefined()
  expect(keys['format.heading1']).toBeUndefined()
  await page.keyboard.press('ControlOrMeta+i')
  expect(
    await page.evaluate(() =>
      (globalThis as unknown as { getSelection(): { toString(): string } })
        .getSelection()
        .toString(),
    ),
  ).toBe('code')
  expect(await body(page).innerText()).not.toContain('*')
  // Back in text they are offered again.
  await page.keyboard.press('ControlOrMeta+Home')
  await expect
    .poll(async () => (await lastMenuState(page))?.keys['format.italic'])
    .toBe('CmdOrCtrl+I')
  expect((await lastMenuState(page))!.keys['format.bold']).toBe('CmdOrCtrl+B')
})

test('Format menu items do nothing outside the editor', async ({ page }) => {
  await newNote(page, 'word')
  await page.keyboard.press('Shift+Home')
  await title(page).click()
  await pick(page, 'format.bold')
  // Anything but a format command is ignored too.
  await pick(page, 'note.trash')
  await pick(page, 'format.nope')
  await body(page).click()
  await page.waitForTimeout(100)
  await expect(body(page)).toHaveText('word')
  await expect(title(page)).toBeVisible()
  await pick(page, 'note.trash')
  await page.waitForTimeout(100)
  await expect(body(page)).toHaveText('word')
})

test('a format key the editor ran is not run again by the menu', async ({ page }) => {
  await newNote(page, 'word')
  await page.keyboard.press('Shift+Home')
  // The key reaches the page and the menu (as when WebKit passes a key the
  // page saw on to the menu bar): one format, not two.
  await keyThenPick(page, 'KeyI', 'format.italic')
  await expect(body(page)).toHaveText('*word*')
  await page.waitForTimeout(100)
  await expect(body(page)).toHaveText('*word*')
  // Only that one event is an echo: picking the item again runs it.
  await pick(page, 'format.italic')
  await expect(body(page)).toHaveText('word')
  // Another format right after a key is a pick of its own.
  await page.keyboard.press('ControlOrMeta+KeyI')
  await expect(body(page)).toHaveText('*word*')
  await pick(page, 'format.bold')
  await expect(body(page)).toHaveText('***word***')
})
