import type { Locator, Page } from '@playwright/test'
import { expect, pickMenuItem, shownMenu, test, type TestWindow } from './fixtures'

// Manual notebook order: a notebook dropped on the top quarter of another
// goes before it, on the bottom quarter after it, in the middle inside it.

const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
/** A notebook's own row (its treeitem holds only the row; sub-notebooks sit beside it). */
const row = (page: Page, name: string) => book(page, name).locator('> .book-row')
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const nameField = (page: Page) => page.getByRole('textbox', { name: 'Notebook name' })

/** The visible notebooks top to bottom, nested ones indented by two spaces a level. */
const shown = (page: Page) =>
  tree(page)
    .getByRole('treeitem')
    .evaluateAll((items) =>
      items.map((item) => {
        const level = Number(item.getAttribute('aria-level'))
        const label = item.querySelector(':scope > .book-row .source-label')?.textContent ?? ''
        return `${'  '.repeat(level - 1)}${label}`
      }),
    )

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  await expect(nameField(page)).toHaveValue('New Notebook')
  await nameField(page).fill(name)
  await nameField(page).press('Enter')
  await expect(book(page, name)).toBeVisible()
}

type Zone = 'top' | 'middle' | 'bottom'

/** A point in a zone of a row: 2 px inside its top or bottom edge, or its centre. */
async function pointIn(target: Locator, zone: Zone) {
  const box = await target.boundingBox()
  if (!box) throw new Error('E_TEST_NO_BOX')
  const y = zone === 'top' ? 2 : zone === 'bottom' ? box.height - 2 : box.height / 2
  return { x: box.width / 2, y }
}

async function drop(source: Locator, target: Locator, zone: Zone) {
  await source.dragTo(target, { targetPosition: await pointIn(target, zone) })
}

/** The insertion line a row draws on its top (before) or bottom (after) edge. */
const line = (target: Locator, edge: 'before' | 'after') =>
  target.evaluate((el, pseudo) => {
    const style = (
      globalThis as unknown as {
        getComputedStyle(e: unknown, p: string): { content: string; height: string }
      }
    ).getComputedStyle(el, pseudo)
    return style.content === 'none' ? null : style.height
  }, `::${edge}`)

/** A row's outline (or, given `property`, that one computed value). */
function outline(target: Locator): Promise<{ style: string; width: string; offset: string }>
function outline(target: Locator, property: string): Promise<string>
function outline(target: Locator, property?: string) {
  return target.evaluate((el, p) => {
    const style = (
      globalThis as unknown as {
        getComputedStyle(e: unknown): Record<string, string> & {
          getPropertyValue(n: string): string
        }
      }
    ).getComputedStyle(el)
    if (p) return style.getPropertyValue(p)
    return { style: style.outlineStyle!, width: style.outlineWidth!, offset: style.outlineOffset! }
  }, property)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('reorders notebooks by their top and bottom edges, and keeps the order', async ({ page }) => {
  await createBook(page, 'Alpha')
  await createBook(page, 'Bravo')
  await createBook(page, 'Charlie')
  // New notebooks go after the others.
  await expect.poll(() => shown(page)).toEqual(['Alpha', 'Bravo', 'Charlie'])

  await drop(row(page, 'Charlie'), row(page, 'Alpha'), 'top')
  await expect.poll(() => shown(page)).toEqual(['Charlie', 'Alpha', 'Bravo'])
  await drop(row(page, 'Charlie'), row(page, 'Alpha'), 'bottom')
  await expect.poll(() => shown(page)).toEqual(['Alpha', 'Charlie', 'Bravo'])
  await drop(row(page, 'Alpha'), row(page, 'Bravo'), 'bottom')
  await expect.poll(() => shown(page)).toEqual(['Charlie', 'Bravo', 'Alpha'])

  await page.reload()
  await expect.poll(() => shown(page)).toEqual(['Charlie', 'Bravo', 'Alpha'])

  // The middle still nests.
  await drop(row(page, 'Alpha'), row(page, 'Charlie'), 'middle')
  await expect.poll(() => shown(page)).toEqual(['Charlie', '  Alpha', 'Bravo'])
})

test('shows where a notebook will go while it is dragged', async ({ page }) => {
  await createBook(page, 'Alpha')
  await createBook(page, 'Bravo')
  const source = row(page, 'Bravo')
  const target = row(page, 'Alpha')
  const from = await source.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error('E_TEST_NO_BOX')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  const hover = async (zone: Zone) => {
    const at = await pointIn(target, zone)
    await page.mouse.move(to.x + at.x, to.y + at.y, { steps: 4 })
  }

  await hover('top')
  await expect(target).toHaveClass(/drop-before/)
  await expect.poll(() => line(target, 'before')).toBe('2px')
  expect(await line(target, 'after')).toBeNull()

  await hover('bottom')
  await expect(target).toHaveClass(/drop-after/)
  await expect(target).not.toHaveClass(/drop-before/)
  await expect.poll(() => line(target, 'after')).toBe('2px')
  expect(await line(target, 'before')).toBeNull()

  await hover('middle')
  await expect(target).toHaveClass(/drop-target/)
  await expect(target).not.toHaveClass(/drop-after/)
  expect(await line(target, 'after')).toBeNull()
  // Into a notebook: a dashed accent outline just inside the row, and the
  // dragged row dims while the drag lasts.
  expect(await outline(target)).toEqual({ style: 'dashed', width: '2px', offset: '-2px' })
  await expect(source).toHaveAttribute('data-dragging', 'true')
  expect(await outline(source, 'opacity')).toBe('0.5')

  // Over itself there is nowhere to go.
  const self = await pointIn(source, 'top')
  await page.mouse.move(from.x + self.x, from.y + self.y, { steps: 4 })
  await expect(source).not.toHaveClass(/drop-/)
  await expect(target).not.toHaveClass(/drop-/)
  await page.mouse.up()
  await expect(source).not.toHaveAttribute('data-dragging')
  await expect.poll(() => shown(page)).toEqual(['Alpha', 'Bravo'])
})

test('dropping beside a sub-notebook moves a notebook into that notebook', async ({ page }) => {
  await createBook(page, 'Work')
  await createBook(page, 'Plan')
  await createBook(page, 'Notes')
  await createBook(page, 'Loose')
  await drop(row(page, 'Plan'), row(page, 'Work'), 'middle')
  await drop(row(page, 'Notes'), row(page, 'Work'), 'middle')
  await expect.poll(() => shown(page)).toEqual(['Work', '  Plan', '  Notes', 'Loose'])

  await drop(row(page, 'Loose'), row(page, 'Plan'), 'bottom')
  await expect.poll(() => shown(page)).toEqual(['Work', '  Plan', '  Loose', '  Notes'])
  // The top edge of the first sub-notebook puts a notebook first inside.
  await drop(row(page, 'Notes'), row(page, 'Plan'), 'top')
  await expect.poll(() => shown(page)).toEqual(['Work', '  Notes', '  Plan', '  Loose'])
  // Back to the top level, before Work.
  await drop(row(page, 'Loose'), row(page, 'Work'), 'top')
  await expect.poll(() => shown(page)).toEqual(['Loose', 'Work', '  Notes', '  Plan'])
  // A notebook never goes beside its own sub-notebooks.
  await drop(row(page, 'Work'), row(page, 'Plan'), 'top')
  await expect.poll(() => shown(page)).toEqual(['Loose', 'Work', '  Notes', '  Plan'])

  await page.reload()
  await expect.poll(() => shown(page)).toEqual(['Loose', 'Work', '  Notes', '  Plan'])
})

test('the bottom edge of an open notebook puts a notebook after it', async ({ page }) => {
  await createBook(page, 'Home')
  await createBook(page, 'Work')
  await createBook(page, 'Plan')
  await drop(row(page, 'Plan'), row(page, 'Work'), 'middle')
  await expect.poll(() => shown(page)).toEqual(['Home', 'Work', '  Plan'])

  // The line runs under Work's sub-notebooks, across Work's width.
  const source = await row(page, 'Home').boundingBox()
  const target = await row(page, 'Work').boundingBox()
  const last = await row(page, 'Plan').boundingBox()
  if (!source || !target || !last) throw new Error('E_TEST_NO_BOX')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height - 2, { steps: 4 })
  await expect(book(page, 'Work')).toHaveClass(/drop-after/)
  await expect(row(page, 'Work')).not.toHaveClass(/drop-/)
  const drawn = await book(page, 'Work').evaluate((el) => {
    const style = (
      globalThis as unknown as {
        getComputedStyle(e: unknown, p: string): { height: string; left: string; bottom: string }
      }
    ).getComputedStyle(el, '::after')
    return { height: style.height, left: style.left, bottom: style.bottom }
  })
  expect(drawn).toEqual({ height: '2px', left: '0px', bottom: '-1px' })
  const work = await book(page, 'Work').boundingBox()
  expect(work && Math.round(work.y + work.height)).toBe(Math.round(last.y + last.height))
  await page.mouse.up()
  await expect.poll(() => shown(page)).toEqual(['Work', '  Plan', 'Home'])
  await expect(book(page, 'Work')).not.toHaveClass(/drop-/)

  await page.reload()
  await expect.poll(() => shown(page)).toEqual(['Work', '  Plan', 'Home'])
})

test('a cancelled note drag leaves no drop highlight', async ({ page }) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Wanderer')
  await createBook(page, 'Home')
  await page.getByRole('button', { name: /All Notes/ }).click()
  const note = noteRows(page).filter({ hasText: 'Wanderer' })
  const target = row(page, 'Home')
  const box = await target.boundingBox()
  if (!box) throw new Error('E_TEST_NO_BOX')
  // A drag cancelled over the row: dragleave comes with the pointer still
  // inside the row, then dragend on the note it started from.
  const data = await page.evaluateHandle(() => {
    const transfer = new (
      globalThis as unknown as {
        DataTransfer: new () => { setData(type: string, value: string): void }
      }
    ).DataTransfer()
    transfer.setData('application/x-devot-note', 'note')
    return transfer
  })
  const at = { dataTransfer: data, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
  await target.dispatchEvent('dragenter', at)
  await target.dispatchEvent('dragover', at)
  await expect(target).toHaveClass(/drop-fill/)
  await target.dispatchEvent('dragleave', at)
  await note.dispatchEvent('dragend', { dataTransfer: data })
  await expect(target).not.toHaveClass(/drop-fill/)
})

test('notebooks from before sort keys keep their name order and get keys', async ({ page }) => {
  // Records as the v10 migration leaves them: no key, no key clock.
  const old = ['Zebra', '\u00c9clair', 'apple'].map((name, i) => ({
    id: `0192a6f0-0000-7000-8000-00000000000${i}`,
    name,
    nameHlc: 'h',
    parentId: null,
    parentHlc: 'h',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    deletedHlc: null,
    aiAccess: false,
    aiAccessHlc: '',
    sortKey: '',
    sortKeyHlc: '',
  }))
  await page.evaluate(
    (books) => localStorage.setItem('devot.test.books', books),
    JSON.stringify(old),
  )
  await page.reload()
  await expect.poll(() => shown(page)).toEqual(['apple', '\u00c9clair', 'Zebra'])
  const keys = () =>
    page.evaluate(() =>
      (
        JSON.parse(localStorage.getItem('devot.test.books') ?? '[]') as {
          name: string
          sortKey: string
          sortKeyHlc: string
        }[]
      )
        .sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))
        .map((b) => `${b.name} ${b.sortKey} ${b.sortKeyHlc || '-'}`),
    )
  await expect.poll(keys).toEqual(['apple a0 -', '\u00c9clair a1 -', 'Zebra a2 -'])
})

test('the Notebooks header puts a notebook first at the top level', async ({ page }) => {
  await createBook(page, 'Work')
  await createBook(page, 'Plan')
  await createBook(page, 'Home')
  await drop(row(page, 'Plan'), row(page, 'Work'), 'middle')
  await expect.poll(() => shown(page)).toEqual(['Work', '  Plan', 'Home'])
  const heading = page.locator('.section-header', { hasText: 'Notebooks' })
  await row(page, 'Plan').dragTo(heading)
  await expect.poll(() => shown(page)).toEqual(['Plan', 'Work', 'Home'])
  await row(page, 'Home').dragTo(heading)
  await expect.poll(() => shown(page)).toEqual(['Home', 'Plan', 'Work'])
})

test('a note dropped anywhere on a notebook row goes into the notebook', async ({ page }) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Wanderer')
  await createBook(page, 'Home')
  await createBook(page, 'Work')
  await page.getByRole('button', { name: /All Notes/ }).click()
  await drop(noteRows(page).filter({ hasText: 'Wanderer' }), row(page, 'Home'), 'top')
  await expect(book(page, 'Home')).toContainText('1')
  await expect.poll(() => shown(page)).toEqual(['Home', 'Work'])
})

test('Move Up and Move Down in the notebook menu', async ({ page }) => {
  await createBook(page, 'Alpha')
  await createBook(page, 'Bravo')
  await createBook(page, 'Charlie')
  const menuFor = async (name: string) => {
    const popups = () =>
      page.evaluate(
        () =>
          (globalThis as unknown as TestWindow).devotIpcCalls.filter(
            (c) => c.cmd === 'plugin:menu|popup',
          ).length,
      )
    const before = await popups()
    await row(page, name).click({ button: 'right' })
    await expect.poll(popups).toBe(before + 1)
    return shownMenu(page)
  }
  // Only the moves there is room for.
  expect(await menuFor('Alpha')).not.toContain('Move Up Alt+ArrowUp')
  expect(await menuFor('Alpha')).toContain('Move Down Alt+ArrowDown')
  expect(await menuFor('Charlie')).toContain('Move Up Alt+ArrowUp')
  expect(await menuFor('Charlie')).not.toContain('Move Down Alt+ArrowDown')

  await menuFor('Charlie')
  await pickMenuItem(page, 'Move Up')
  await expect.poll(() => shown(page)).toEqual(['Alpha', 'Charlie', 'Bravo'])
  await menuFor('Alpha')
  await pickMenuItem(page, 'Move Down')
  await expect.poll(() => shown(page)).toEqual(['Charlie', 'Alpha', 'Bravo'])
  await page.reload()
  await expect.poll(() => shown(page)).toEqual(['Charlie', 'Alpha', 'Bravo'])
})
