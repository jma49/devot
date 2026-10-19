import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// A new note's editor loads its body after the note shows and then takes the
// keyboard. A user quicker than that load, already typing in the title (or in
// the palette), keeps the keyboard there: nothing typed lands in the body.

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })

interface StoredNote {
  title: string
  bodyMd: string
}

const storedNotes = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as StoredNote[])

test.beforeEach(async ({ page }) => {
  // The core's replies to `open` (an editor loading its body) come 500 ms
  // late, as on a busy machine, so the keys below always beat the load.
  await page.addInitScript(() => {
    const late = new Set<unknown>()
    const post = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      const data = args[0] as { id?: unknown; path?: unknown[] } | undefined
      if (data?.path?.length === 1 && data.path[0] === 'open') late.add(data.id)
      post.apply(this, args)
    } as Worker['postMessage']
    const listen = Worker.prototype.addEventListener
    Worker.prototype.addEventListener = function (
      this: Worker,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type !== 'message' || typeof listener !== 'function') {
        return listen.call(this, type, listener, options)
      }
      const delayed = (event: Event) => {
        const id = (event as MessageEvent<{ id?: unknown }>).data?.id
        if (!late.has(id)) return listener.call(this, event)
        // Every listener on the worker sees the reply late; the id is done after.
        setTimeout(() => {
          late.delete(id)
          listener.call(this, event)
        }, 500)
      }
      return listen.call(this, type, delayed, options)
    }
  })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('notes made back to back keep each title in the title and each body in the body', async ({
  page,
}) => {
  const made: StoredNote[] = []
  for (let i = 1; i <= 10; i += 1) {
    const before = await noteRows(page).count()
    await page.getByRole('button', { name: 'New Note', exact: true }).click()
    await expect(noteRows(page)).toHaveCount(before + 1)
    await titleField(page).click()
    await page.keyboard.type('Title ')
    await expect(body(page)).toBeVisible()
    await page.keyboard.type(`${i}`)
    await expect(titleField(page)).toHaveValue(`Title ${i}`)
    await body(page).click()
    await page.keyboard.type(`Body ${i}.`)
    made.push({ title: `Title ${i}`, bodyMd: `Body ${i}.` })
  }
  await expect
    .poll(async () =>
      (await storedNotes(page))
        .map(({ title, bodyMd }) => ({ title, bodyMd }))
        .sort((a, b) => a.title.localeCompare(b.title, 'en', { numeric: true })),
    )
    .toEqual(made)
})
