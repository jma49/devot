import type { Page } from '@playwright/test'
import {
  changeShortcutsElsewhere,
  clipboardWrites,
  expect,
  reloadApp,
  test,
  type TestWindow,
} from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
/** A tag's filter row in the sidebar ("<name> <count>", after its colour if it has one). */
const tagRow = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^(?:[A-Z][a-z]+ )*${name} \\d+$`) })
const editorTags = (page: Page) => page.getByRole('group', { name: 'Tags' })

interface StoredTag {
  id: string
  name: string
  color: string | null
}

/** Tags the in-memory store holds (saved state, not the screen). */
const storedTags = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('devot.test.tags') ?? '[]') as StoredTag[])

interface StoredLink {
  noteId: string
  tagId: string
  present: boolean
}

const storedLinks = (page: Page) =>
  page.evaluate(
    () => JSON.parse(localStorage.getItem('devot.test.noteTags') ?? '[]') as StoredLink[],
  )

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await expect(noteRow(page, title)).toHaveCount(1)
}

async function addTag(page: Page, name: string) {
  const field = page.getByRole('combobox', { name: 'Add Tag' })
  await field.fill(name)
  await field.press('Enter')
  // A chip, not the suggestions' closing copy that fades out beside them.
  await expect(
    editorTags(page)
      .locator('.chip')
      .filter({ hasText: new RegExp(`^${name}$`) }),
  ).toBeVisible()
}

const menu = (page: Page) => page.getByRole('menu', { name: 'Tag' })

async function openMenu(page: Page, name: string) {
  await tagRow(page, name).click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
}

async function pickItem(page: Page, name: string) {
  await menu(page).getByRole('menuitem', { name, exact: false }).click()
}

const pickColor = (page: Page, name: string) =>
  menu(page).getByRole('menuitemradio', { name }).click()

/** "One" tagged sync and idea, "Two" tagged idea; "Two" is open. */
async function setUp(page: Page) {
  await createNote(page, 'One')
  await addTag(page, 'sync')
  await addTag(page, 'idea')
  await createNote(page, 'Two')
  await addTag(page, 'idea')
  await expect(tagRow(page, 'idea')).toHaveText(/2$/)
}

const painted = (page: Page, selector: string, color: string) =>
  page.evaluate(
    ([sel, id]) => {
      // This config has no DOM types.
      interface El {
        style: { setProperty(name: string, value: string): void }
        remove(): void
      }
      const w = globalThis as unknown as {
        document: {
          querySelector(s: string): El | null
          createElement(tag: string): El
          body: { append(el: El): void }
        }
        getComputedStyle(el: El): { color: string; backgroundColor: string }
      }
      const el = w.document.querySelector(sel)
      const probe = w.document.createElement('span')
      probe.style.setProperty('color', `var(--color-tag-${id})`)
      w.document.body.append(probe)
      const want = w.getComputedStyle(probe).color
      probe.remove()
      return { got: el ? w.getComputedStyle(el).backgroundColor : null, want }
    },
    [selector, color] as const,
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('right-click shows the tag menu at the pointer, in the window', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'sync')
  const items = menu(page).getByRole('menuitem').or(menu(page).getByRole('menuitemcheckbox'))
  await expect(items).toHaveText([
    'Tag Settings\u2026',
    /^Filter by Tag$/,
    'Copy Tag ID',
    /^Delete Tag/,
  ])
  await expect(
    menu(page).getByRole('group', { name: 'Color' }).getByRole('menuitemradio'),
  ).toHaveCount(10)
  const box = (await menu(page).boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
})

test('the menu works by keyboard: arrows, Return, Escape and focus back', async ({ page }) => {
  await setUp(page)
  await tagRow(page, 'idea').focus()
  await page.keyboard.press('Shift+F10')
  await expect(menu(page).getByRole('menuitem', { name: 'Tag Settings' })).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await expect(menu(page).getByRole('menuitemradio', { name: 'None' })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(menu(page).getByRole('menuitemradio', { name: 'Red' })).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(menu(page).getByRole('menuitemradio', { name: 'Custom Color' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu(page).getByRole('menuitemcheckbox', { name: 'Filter by Tag' })).toBeFocused()
  await page.keyboard.press('End')
  await expect(menu(page).getByRole('menuitem', { name: 'Delete Tag' })).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(tagRow(page, 'idea')).toBeFocused()

  await page.keyboard.press('Shift+F10')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await expect(menu(page)).toHaveCount(0)
  await expect(tagRow(page, 'idea').locator('.tag-dot')).toHaveAttribute('data-color', 'red')
  await expect(tagRow(page, 'idea')).toBeFocused()
})

test('a click outside closes the menu and changes nothing', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'idea')
  await page.getByRole('textbox', { name: 'Title' }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(tagRow(page, 'idea').locator('.tag-dot[data-color]')).toHaveCount(0)
})

const picker = (page: Page) => page.getByRole('dialog', { name: 'Custom Color' })

test('the picker sets a colour by hex, and it stays after a reload', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'idea')
  await pickColor(page, 'Custom Color')
  const hex = picker(page).getByRole('textbox', { name: 'Hex' })
  await hex.fill('#zz')
  await expect(hex).toHaveAttribute('aria-invalid', 'true')
  await expect(picker(page).getByRole('button', { name: 'Done' })).toBeDisabled()
  await hex.fill('#FF00AA')
  await expect(hex).toHaveAttribute('aria-invalid', 'false')
  await hex.press('Enter')
  await expect(picker(page)).toHaveCount(0)
  const dot = tagRow(page, 'idea').locator('.tag-dot')
  await expect(dot).toHaveAttribute('data-color', '#ff00aa')
  expect((await storedTags(page)).find((t) => t.name === 'idea')?.color).toBe('#ff00aa')
  await page.reload()
  await expect(dot).toHaveCSS('background-color', 'rgb(255, 0, 170)')
})

test('the picker moves by keyboard on both areas', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'idea')
  await pickColor(page, 'Custom Color')
  const spectrum = picker(page).getByRole('slider', { name: 'Saturation and brightness' })
  const hue = picker(page).getByRole('slider', { name: 'Hue' })
  const hex = picker(page).getByRole('textbox', { name: 'Hex' })
  await expect(spectrum).toBeFocused()
  const start = await hex.inputValue()
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(spectrum).toHaveAttribute('aria-valuenow', '60')
  await page.keyboard.press('ArrowUp')
  await expect(hex).not.toHaveValue(start)
  await hue.focus()
  await page.keyboard.press('Home')
  await expect(hue).toHaveAttribute('aria-valuenow', '0')
  await page.keyboard.press('ArrowRight')
  await expect(hue).toHaveAttribute('aria-valuenow', '1')
  await page.keyboard.press('Escape')
  await expect(picker(page)).toHaveCount(0)
  await expect(menu(page)).toBeVisible()
  expect((await storedTags(page)).find((t) => t.name === 'idea')?.color ?? null).toBeNull()
})

test('the picker follows a pointer drag', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'idea')
  await pickColor(page, 'Custom Color')
  const spectrum = picker(page).getByRole('slider', { name: 'Saturation and brightness' })
  const box = (await spectrum.boundingBox())!
  await page.mouse.move(box.x + 2, box.y + 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 2, box.y - 20, { steps: 4 })
  await expect(spectrum).toHaveAttribute('aria-valuenow', '100')
  await page.mouse.up()
  const hue = picker(page).getByRole('slider', { name: 'Hue' })
  const strip = (await hue.boundingBox())!
  await page.mouse.click(strip.x + strip.width / 2, strip.y + strip.height / 2)
  await expect(hue).toHaveAttribute('aria-valuenow', '180')
  await picker(page).getByRole('button', { name: 'Done' }).click()
  await expect(tagRow(page, 'idea').locator('.tag-dot')).toHaveAttribute('data-color', '#00ffff')
})

test('Tag Settings opens the picker from its custom swatch', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'idea')
  await pickItem(page, 'Tag Settings…')
  const dialog = page.getByRole('dialog', { name: 'Tag Settings' })
  await dialog.getByRole('radio', { name: 'Custom Color' }).click()
  const hex = dialog.getByRole('textbox', { name: 'Hex' })
  await hex.fill('#123456')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog.getByRole('radio', { name: 'Custom Color' })).toBeChecked()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(tagRow(page, 'idea').locator('.tag-dot')).toHaveAttribute('data-color', '#123456')
})

test('a colour shows as the sidebar dot and on chips, and survives a reload', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'idea')
  await pickColor(page, 'Purple')

  const dot = tagRow(page, 'idea').locator('.tag-dot')
  await expect(dot).toHaveAttribute('data-color', 'purple')
  await expect(tagRow(page, 'idea')).toHaveAccessibleName('Purple idea 2')
  await expect(tagRow(page, 'sync').locator('.tag-dot[data-color]')).toHaveCount(0)
  await expect(noteRow(page, 'One').locator('.chip .tag-dot')).toHaveCount(1)
  await expect(
    noteRow(page, 'Two').locator('.chip', { hasText: 'idea' }).locator('.tag-dot'),
  ).toHaveAttribute('data-color', 'purple')
  await expect(
    editorTags(page).locator('.chip', { hasText: 'idea' }).locator('.tag-dot'),
  ).toHaveAttribute('data-color', 'purple')
  const { got, want } = await painted(page, '.sources.tags .tag-dot', 'purple')
  expect(got).toBe(want)
  expect(await storedTags(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'idea', color: 'purple' })]),
  )

  await openMenu(page, 'idea')
  await expect(menu(page).getByRole('menuitemradio', { name: 'Purple' })).toBeChecked()
  await expect(menu(page).getByRole('menuitemradio', { name: 'None' })).not.toBeChecked()

  await page.reload()
  await expect(tagRow(page, 'idea').locator('.tag-dot')).toHaveAttribute('data-color', 'purple')

  await openMenu(page, 'idea')
  await pickColor(page, 'None')
  await expect(tagRow(page, 'idea').locator('.tag-dot[data-color]')).toHaveCount(0)
  await expect(page.locator('.chip .tag-dot')).toHaveCount(0)
})

test('Filter by Tag filters the list by the right-clicked tag, and again clears it', async ({
  page,
}) => {
  await setUp(page)
  await openMenu(page, 'sync')
  await menu(page).getByRole('menuitemcheckbox', { name: 'Filter by Tag' }).click()
  await expect(header(page)).toHaveText('sync')
  await expect(noteRows(page)).toHaveText([/^One/])
  await expect(tagRow(page, 'sync')).toHaveAttribute('aria-pressed', 'true')

  await openMenu(page, 'sync')
  await expect(menu(page).getByRole('menuitemcheckbox', { name: 'Filter by Tag' })).toBeChecked()
  await menu(page).getByRole('menuitemcheckbox', { name: 'Filter by Tag' }).click()
  await expect(header(page)).toHaveText('All Notes')
  await expect(noteRows(page)).toHaveCount(2)
})

test('Copy Tag ID writes the tag ID', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'sync')
  await pickItem(page, 'Copy Tag ID')
  await expect.poll(() => clipboardWrites(page)).toHaveLength(1)
  const sync = (await storedTags(page)).find((t) => t.name === 'sync')
  expect(sync?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(await clipboardWrites(page)).toEqual([sync?.id])
})

test('keys set in Settings filter by a tag and copy its ID from its row', async ({ page }) => {
  await setUp(page)
  await changeShortcutsElsewhere(page, { 'tag.filter': ['F'], 'tag.copyId': ['I'] })
  await tagRow(page, 'sync').focus()
  await page.keyboard.press('KeyF')
  await expect(header(page)).toHaveText('sync')
  await expect(noteRows(page)).toHaveText([/^One/])
  await tagRow(page, 'sync').focus()
  await page.keyboard.press('KeyI')
  const sync = (await storedTags(page)).find((t) => t.name === 'sync')
  await expect.poll(() => clipboardWrites(page)).toEqual([sync?.id])
  await tagRow(page, 'sync').focus()
  await page.keyboard.press('KeyF')
  await expect(header(page)).toHaveText('All Notes')
})

test('F2 edits the name in place; the chips follow', async ({ page }) => {
  await setUp(page)
  await tagRow(page, 'idea').focus()
  await page.keyboard.press('F2')
  const field = sidebar(page).getByRole('textbox', { name: 'Tag name' })
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('idea')
  await field.fill('ideas')
  await field.press('Enter')
  await expect(tagRow(page, 'ideas')).toHaveText(/2$/)
  await expect(noteRow(page, 'One')).toContainText('ideas')
  await expect(editorTags(page)).toContainText('ideas')
})

test('Delete Tag asks first, then removes it from the sidebar and every note', async ({ page }) => {
  await setUp(page)
  const confirm = page.getByRole('dialog', { name: 'Delete the tag \u201cidea\u201d?' })
  await openMenu(page, 'idea')
  await pickItem(page, 'Delete Tag')
  await expect(confirm).toContainText('It will be removed from 2 notes.')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(tagRow(page, 'idea')).toHaveText(/2$/)

  await openMenu(page, 'idea')
  await pickItem(page, 'Delete Tag')
  await confirm.getByRole('button', { name: 'Delete Tag' }).click()
  await expect(tagRow(page, 'idea')).toHaveCount(0)
  await expect(tagRow(page, 'sync')).toHaveText(/1$/)
  await expect(noteRows(page).locator('.chip', { hasText: 'idea' })).toHaveCount(0)
  await expect(editorTags(page)).not.toContainText('idea')
})

test('Tag Settings sets the name and the colour from the tag palette', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'idea')
  await pickItem(page, 'Tag Settings…')
  const dialog = page.getByRole('dialog', { name: 'Tag Settings' })
  await expect(dialog.getByRole('textbox', { name: 'Tag name' })).toHaveValue('idea')
  await dialog.getByRole('textbox', { name: 'Tag name' }).fill('thoughts')
  await dialog.getByRole('radio', { name: 'Blue' }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(tagRow(page, 'thoughts')).toBeVisible()
  expect((await storedTags(page)).find((t) => t.name === 'thoughts')?.color).toBe('blue')
})

test('a suggestion picked from two tags of one name goes on by ID', async ({ page }) => {
  await createNote(page, 'One')
  await addTag(page, 'Work')
  const first = (await storedTags(page))[0]!
  // A second tag of the same name, as sync may bring.
  const second = { ...first, id: '0192a6f0-0000-7000-8000-0000000000b2' }
  await page.evaluate(
    (tags) => localStorage.setItem('devot.test.tags', JSON.stringify(tags)),
    [first, second],
  )
  await reloadApp(page)
  await noteRow(page, 'One').click()
  await expect(editorTags(page)).toBeVisible()
  // The first is on the note already, so the other is the only suggestion.
  const field = page.getByRole('combobox', { name: 'Add Tag' })
  await field.fill('Work')
  const options = page.getByRole('listbox', { name: 'Tag suggestions' }).getByRole('option')
  await expect(options).toHaveCount(1)
  await options.first().click()
  await expect(editorTags(page).locator('.chip')).toHaveCount(2)
  await expect
    .poll(async () =>
      (await storedLinks(page))
        .filter((link) => link.present)
        .map((link) => link.tagId)
        .sort(),
    )
    .toEqual([first.id, second.id].sort())
})

test('a Copy Tag ID that fails says so, with its code', async ({ page }) => {
  await setUp(page)
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      clipboard_write_text: { error: 'E_CLIPBOARD_WRITE_FAILED' },
    }
  })
  await openMenu(page, 'idea')
  await pickItem(page, 'Copy Tag ID')
  await expect(page.getByRole('alert')).toContainText(
    'The ID could not be copied (E_CLIPBOARD_WRITE_FAILED).',
  )
})
