import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test, type TestWindow } from './fixtures'

// The paste chooser: with Paste URL as Link set to Choose each time, a lone
// URL goes in as copied and a list of formats opens on it. The highlighted
// format shows in the URL's place; a page title or a GitHub file is fetched
// (link_title, github_snippet: mocked here) only once highlighted.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const line = (page: Page, n: number) => page.locator('.cm-line').nth(n)
const lines = (page: Page) => page.locator('.cm-line').allTextContents()
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const formats = (page: Page) => page.locator('.cm-tooltip-autocomplete li .cm-completionLabel')
const previewOf = (page: Page) => page.locator('.cm-link-format-preview')
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const paletteField = (page: Page) =>
  palette(page).getByRole('combobox', { name: 'Command Palette' })

async function newNote(page: Page, text: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await body(page).click()
  await page.keyboard.insertText(text)
  await expect(line(page, 0)).toHaveText(text.split('\n')[0] ?? '')
}

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

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (name) =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter((c) => c.cmd === name).length,
    cmd,
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('a pasted URL offers its formats; the title is fetched only once highlighted', async ({
  page,
}) => {
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      // Slow enough to show the loading state.
      link_title: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('Example [Docs]'), 400)
        }),
    }
  })
  await newNote(page, 'link: ')
  await changeEditorSettingsElsewhere(page, { pasteUrl: 'choose' })
  await body(page).click()
  await page.keyboard.press('End')
  await paste(page, 'https://example.com/docs')
  await expect(line(page, 0)).toHaveText('link: https://example.com/docs')
  await expect(formats(page)).toHaveText([
    'Plain URL',
    'With Page Title',
    'With Empty Title',
    'With Angle Brackets',
  ])
  expect(await calls(page, 'link_title')).toBe(0)

  // Highlighted: fetched, loading, then shown in the URL's place.
  await page.keyboard.press('ArrowDown')
  await expect(previewOf(page)).toHaveText('Loading…')
  await expect(previewOf(page)).toHaveText('[Example \\[Docs\\]](https://example.com/docs)')
  expect(await calls(page, 'link_title')).toBe(1)

  // The empty link previews too, without fetching.
  await page.keyboard.press('ArrowDown')
  await expect(previewOf(page)).toHaveText('[](https://example.com/docs)')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(line(page, 0)).toHaveText('link: [Example \\[Docs\\]](https://example.com/docs)')
  await expect(previewOf(page)).toHaveCount(0)
  expect(await calls(page, 'link_title')).toBe(1)

  // One undo step takes back the pick and the paste.
  await page.keyboard.press('ControlOrMeta+z')
  await expect(line(page, 0)).toHaveText('link: ')
})

test('Escape keeps the URL as copied and fetches nothing', async ({ page }) => {
  await newNote(page, 'x ')
  await changeEditorSettingsElsewhere(page, { pasteUrl: 'choose' })
  await body(page).click()
  await page.keyboard.press('End')
  await paste(page, 'https://example.com/')
  await expect(formats(page)).toHaveCount(4)
  await page.keyboard.press('Escape')
  await expect(formats(page)).toHaveCount(0)
  await page.keyboard.insertText(' after')
  await expect(line(page, 0)).toHaveText('x https://example.com/ after')
  expect(await calls(page, 'link_title')).toBe(0)
})

test('a failed fetch says why in the preview', async ({ page }) => {
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { ...w.devotIpcMocks, link_title: { error: 'E_LINK_NOT_HTML' } }
  })
  await newNote(page, 'x ')
  await changeEditorSettingsElsewhere(page, { pasteUrl: 'choose' })
  await body(page).click()
  await page.keyboard.press('End')
  await paste(page, 'https://example.com/file.pdf')
  await page.keyboard.press('ArrowDown')
  await expect(previewOf(page)).toHaveText('Could not get the page title: the page is not HTML.')
  await page.keyboard.press('Enter')
  await expect(line(page, 0)).toHaveText('x https://example.com/file.pdf')
})

test('a GitHub file link pastes as a fenced snippet', async ({ page }) => {
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { ...w.devotIpcMocks, github_snippet: 'one\ntwo\nthree\n' }
  })
  const link = 'https://github.com/o/r/blob/main/src/a.ts#L2-L3'
  await newNote(page, 'Top')
  await changeEditorSettingsElsewhere(page, { pasteUrl: 'choose' })
  await body(page).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await paste(page, link)
  await expect(formats(page)).toHaveText([
    'Plain URL',
    'GitHub Code Snippet',
    'With Page Title',
    'With Empty Title',
    'With Angle Brackets',
  ])
  await page.keyboard.press('ArrowDown')
  await expect(previewOf(page)).toContainText('```ts line=2-3 branch=main')
  await page.keyboard.press('Enter')
  await expect
    .poll(() => lines(page))
    .toEqual(['Top', `\`\`\`ts line=2-3 branch=main url=${link}`, 'two', 'three', '```'])
  expect(await calls(page, 'github_snippet')).toBe(1)
})

test('Paste URL As… opens the chooser for the clipboard URL', async ({ page }) => {
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { ...w.devotIpcMocks, clipboard_read_text: 'https://a.example/' }
  })
  // The default setting pastes an empty link; the command asks.
  await newNote(page, 'go ')
  await page.keyboard.press('Meta+KeyK')
  await expect(paletteField(page)).toBeFocused()
  await paletteField(page).fill('Paste URL As')
  await page.keyboard.press('Enter')
  await expect(line(page, 0)).toHaveText('go https://a.example/')
  await expect(formats(page)).toHaveCount(4)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(line(page, 0)).toHaveText('go <https://a.example/>')
})
