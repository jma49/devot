import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

async function newNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
}

async function dragStart(row: ReturnType<typeof noteRows>) {
  return row.evaluate((el) => {
    // This config has no DOM types: the few browser classes used here.
    const w = globalThis as unknown as {
      DataTransfer: new () => {
        effectAllowed: string
        getData(type: string): string
        types: readonly string[]
      }
      DragEvent: new (type: string, init: object) => unknown
    }
    const dt = new w.DataTransfer()
    el.dispatchEvent(
      new (w.DragEvent as unknown as new (t: string, i: object) => Event)('dragstart', {
        bubbles: true,
        dataTransfer: dt,
      }),
    )
    return {
      effect: dt.effectAllowed,
      types: [...dt.types],
      plain: dt.getData('text/plain'),
      html: dt.getData('text/html'),
      ids: dt.getData('application/x-devot-note'),
    }
  })
}

test('a note row drags out as a Markdown link and an anchor', async ({ page }) => {
  await newNote(page, 'Plan <1> & "two"')
  await expect(noteRows(page).first()).toContainText('Plan')
  const data = await dragStart(noteRows(page).first())
  expect(data.plain).toBe(`[Plan <1> & "two"](devot://note/${data.ids})`)
  expect(data.html).toBe(
    `<a href="devot://note/${data.ids}">Plan &lt;1&gt; &amp; &quot;two&quot;</a>`,
  )
  expect(data.types).not.toContain('text/uri-list')
})

test('a notebook row drags out as Name:id', async ({ page }) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await field.fill('Work')
  await field.press('Enter')
  const row = tree(page)
    .getByRole('treeitem', { name: /^Work\b/ })
    .locator('> .book-row')
  const data = await row.evaluate((el) => {
    const w = globalThis as unknown as {
      DataTransfer: new () => {
        effectAllowed: string
        getData(type: string): string
      }
      DragEvent: new (type: string, init: object) => Event
    }
    const dt = new w.DataTransfer()
    el.dispatchEvent(new w.DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    return {
      effect: dt.effectAllowed,
      plain: dt.getData('text/plain'),
      id: dt.getData('application/x-devot-book'),
    }
  })
  expect(data.id).not.toBe('')
  expect(data.plain).toBe(`Work:${data.id}`)
})

test('notes dropped on the editor insert their links as one undo step', async ({ page }) => {
  await newNote(page, 'Target')
  await body(page).click()
  await page.keyboard.type('before')
  await page.getByRole('textbox', { name: 'Title' }).fill('Target')
  await body(page).evaluate((el) => {
    const w = globalThis as unknown as {
      DataTransfer: new () => { setData(type: string, value: string): void }
      DragEvent: new (type: string, init: object) => Event
    }
    const dt = new w.DataTransfer()
    dt.setData('application/x-devot-note', 'a\nb')
    dt.setData('text/plain', '[One](devot://note/a)\n[Two](devot://note/b)')
    const box = (
      el as unknown as { getBoundingClientRect(): { left: number; top: number } }
    ).getBoundingClientRect()
    el.dispatchEvent(
      new w.DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: box.left + 400,
        clientY: box.top + 5,
      }),
    )
  })
  await expect(body(page)).toContainText('[One](devot://note/a)')
  await expect(body(page)).toContainText('[Two](devot://note/b)')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(body(page)).not.toContainText('devot://note/a')
  await expect(body(page)).toContainText('before')
})

test('a note or notebook dropped on the title field does not insert text', async ({ page }) => {
  await newNote(page, 'Keep')
  const title = page.getByRole('textbox', { name: 'Title' })
  const dropped = await title.evaluate((el) => {
    const w = globalThis as unknown as {
      DataTransfer: new () => { setData(type: string, value: string): void }
      DragEvent: new (type: string, init: object) => Event
    }
    const dt = new w.DataTransfer()
    dt.setData('application/x-devot-book', 'k')
    dt.setData('text/plain', 'Work:k')
    const event = new w.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
    el.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(dropped).toBe(true)
  await expect(title).toHaveValue('Keep')
})
