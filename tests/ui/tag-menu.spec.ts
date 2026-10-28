import type { Page } from '@playwright/test'
import {
  changeShortcutsElsewhere,
  clipboardWrites,
  expect,
  pickMenuItem,
  reloadApp,
  shownMenu,
  test,
  type TestWindow,
} from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
/** A tag's filter row in the sidebar ("<name> <count>", after its colour if it has one). */
const tagRow = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^(?:[A-Z][a-z]+ )?${name} \\d+$`) })
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

const popups = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd === 'plugin:menu|popup',
      ).length,
  )

async function openMenu(page: Page, name: string) {
  const before = await popups(page)
  await tagRow(page, name).click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
}

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
        getComputedStyle(el: El): { color: string; borderTopColor: string }
      }
      const el = w.document.querySelector(sel)
      const probe = w.document.createElement('span')
      probe.style.setProperty('color', `var(--color-tag-${id})`)
      w.document.body.append(probe)
      const want = w.getComputedStyle(probe).color
      probe.remove()
      return { got: el ? w.getComputedStyle(el).borderTopColor : null, want }
    },
    [selector, color] as const,
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('right-click shows the native tag menu with a Colour submenu', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'sync')
  expect(await shownMenu(page)).toEqual([
    'Tag Settings…',
    'Colour >',
    '  None [x]',
    '  Red [ ]',
    '  Orange [ ]',
    '  Yellow [ ]',
    '  Green [ ]',
    '  Blue [ ]',
    '  Purple [ ]',
    '  Pink [ ]',
    '  Grey [ ]',
    '---',
    'Filter by Tag [ ]',
    '---',
    'Copy Tag ID',
    '---',
    'Delete Tag Backspace',
  ])
})

test('a colour shows as the sidebar dot and on chips, and survives a reload', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'idea')
  await pickMenuItem(page, 'Purple', 'Colour')

  const dot = tagRow(page, 'idea').locator('.tag-dot')
  await expect(dot).toHaveAttribute('data-color', 'purple')
  await expect(tagRow(page, 'idea')).toHaveAccessibleName('Purple idea 2')
  await expect(tagRow(page, 'sync').locator('.tag-dot')).toHaveCount(0)
  await expect(noteRow(page, 'One').locator('.chip .tag-dot')).toHaveCount(1)
  await expect(
    noteRow(page, 'Two').locator('.chip', { hasText: 'idea' }).locator('.tag-dot'),
  ).toHaveAttribute('data-color', 'purple')
  await expect(
    editorTags(page).locator('.chip', { hasText: 'idea' }).locator('.tag-dot'),
  ).toHaveAttribute('data-color', 'purple')
  // Edged with the theme's token for the colour (its fill is a wash of it).
  const { got, want } = await painted(page, '.sources.tags .tag-dot', 'purple')
  expect(got).toBe(want)
  expect(await storedTags(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'idea', color: 'purple' })]),
  )

  await openMenu(page, 'idea')
  expect(await shownMenu(page)).toEqual(expect.arrayContaining(['  None [ ]', '  Purple [x]']))

  await page.reload()
  await expect(tagRow(page, 'idea').locator('.tag-dot')).toHaveAttribute('data-color', 'purple')

  await openMenu(page, 'idea')
  await pickMenuItem(page, 'None', 'Colour')
  await expect(tagRow(page, 'idea').locator('.tag-dot')).toHaveCount(0)
  await expect(page.locator('.chip .tag-dot')).toHaveCount(0)
})

test('Filter by Tag filters the list by the right-clicked tag, and again clears it', async ({
  page,
}) => {
  await setUp(page)
  await openMenu(page, 'sync')
  await pickMenuItem(page, 'Filter by Tag')
  await expect(header(page)).toHaveText('sync')
  await expect(noteRows(page)).toHaveText([/^One/])
  await expect(tagRow(page, 'sync')).toHaveAttribute('aria-pressed', 'true')

  await openMenu(page, 'sync')
  expect(await shownMenu(page)).toContain('Filter by Tag [x]')
  await pickMenuItem(page, 'Filter by Tag')
  await expect(header(page)).toHaveText('All Notes')
  await expect(noteRows(page)).toHaveCount(2)
})

test('Copy Tag ID writes the tag ID', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'sync')
  await pickMenuItem(page, 'Copy Tag ID')
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
  await pickMenuItem(page, 'Delete Tag')
  await expect(confirm).toContainText('It will be removed from 2 notes.')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(tagRow(page, 'idea')).toHaveText(/2$/)

  await openMenu(page, 'idea')
  await pickMenuItem(page, 'Delete Tag')
  await confirm.getByRole('button', { name: 'Delete Tag' }).click()
  await expect(tagRow(page, 'idea')).toHaveCount(0)
  await expect(tagRow(page, 'sync')).toHaveText(/1$/)
  await expect(noteRows(page).locator('.chip', { hasText: 'idea' })).toHaveCount(0)
  await expect(editorTags(page)).not.toContainText('idea')
})

test('Tag Settings sets the name and the colour from the tag palette', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'idea')
  await pickMenuItem(page, 'Tag Settings…')
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
  await pickMenuItem(page, 'Copy Tag ID')
  await expect(page.getByRole('alert')).toContainText(
    'The ID could not be copied (E_CLIPBOARD_WRITE_FAILED).',
  )
})
