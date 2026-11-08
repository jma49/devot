import type { Page } from '@playwright/test'
import * as Y from 'yjs'
import { changeEditorSettingsElsewhere, expect, test } from './fixtures'
import { openPhoneNote } from './phone'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

interface EditorViewLike {
  state: { doc: { length: number } }
  dispatch(spec: unknown): void
}

const note = (page: Page) => page.locator('section.phone-screen:has(.phone-note-scroll)')

const atDoubleText = (page: Page) =>
  page.locator('.phone-app').evaluate((app) => {
    const root = app
    root.style.setProperty('--phone-text-scale', '2')
    root.dataset['textSize'] = 'accessibility'
  })

const openFirstNote = async (page: Page) => {
  await openPhoneNote(page)
  await expect(note(page).locator('.cm-content')).toBeAttached()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
  await openFirstNote(page)
})

test('the top bar has back, a mono crumb and a capsule; the title is 26 bold', async ({ page }) => {
  const heading = note(page).locator('.phone-note-heading')
  await expect(heading).toHaveCSS('font-weight', '700')
  await expect(note(page).locator('.phone-note-caption')).toHaveClass(/phone-figures/)
  await expect(note(page).getByRole('button', { name: 'Back', exact: true })).toBeVisible()
  await expect(note(page).locator('.phone-note-crumb')).toHaveCSS(
    'font-family',
    /mono|Menlo|Courier/i,
  )
})

test('the mode toggle swaps Edit and Preview', async ({ page }) => {
  const toEdit = note(page).getByRole('button', { name: 'Edit', exact: true })
  const toPreview = note(page).getByRole('button', { name: 'Preview', exact: true })
  await expect(note(page).locator('.phone-note-preview')).toHaveAttribute('data-shown', 'true')
  await toEdit.click()
  await expect(note(page).locator('.phone-note-preview')).not.toHaveAttribute('data-shown', 'true')
  await toPreview.click()
  await expect(note(page).locator('.phone-note-preview')).toHaveAttribute('data-shown', 'true')
})

test('the preview body is drawn at the Preview Font Size it shows', async ({ page }) => {
  const body = note(page).locator('.preview p').first()
  await changeEditorSettingsElsewhere(page, { previewFontSize: 15 })
  await expect(body).toHaveCSS('font-size', '15px')
  await changeEditorSettingsElsewhere(page, { previewFontSize: 20 })
  await expect(body).toHaveCSS('font-size', '20px')
})

test("Preview and Edit text share the title's edges", async ({ page }) => {
  const heading = (await note(page).locator('.phone-note-heading').boundingBox())!
  const paragraph = (await note(page).locator('.preview p').first().boundingBox())!
  expect(Math.abs(paragraph.x - heading.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(paragraph.x + paragraph.width - (heading.x + heading.width))).toBeLessThanOrEqual(
    1,
  )

  await note(page).getByRole('button', { name: 'Edit', exact: true }).click()
  const line = note(page).locator('.cm-line').first()
  await expect(line).toBeVisible()
  const box = (await line.boundingBox())!
  const inset = await line.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
  expect(Math.abs(box.x + inset - heading.x)).toBeLessThanOrEqual(1)
})

test('a long title at twice the text size wraps uncropped, and Return adds no line', async ({
  page,
}) => {
  await atDoubleText(page)
  const heading = note(page).locator('.phone-note-heading')
  const oneLine = (await heading.boundingBox())!.height
  const long = 'A long title that takes several lines at this text size to read in full'
  await heading.fill(long)
  await heading.press('Enter')
  await expect(heading).toHaveValue(long)
  const seen = await heading.evaluate((el) => ({
    client: el.clientHeight,
    scroll: el.scrollHeight,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight),
  }))
  expect(seen.client).toBeGreaterThanOrEqual(2 * seen.lineHeight)
  expect(seen.scroll).toBeLessThanOrEqual(seen.client)
  expect(seen.client).toBeGreaterThan(oneLine)
  await heading.fill('Pasted\nacross lines')
  await expect(heading).toHaveValue('Pasted across lines')
  await heading.fill(long)
  await heading.blur()
  await expect(note(page)).toHaveAttribute('aria-label', long)
})

test('wrapped chips are 44 tall around a 30 face, and their targets do not overlap', async ({
  page,
}) => {
  await page.evaluate(() => {
    const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as { id: string }[]
    const tags = Array.from({ length: 8 }, (_, i) => ({
      id: `seeded-tag-${i}`,
      name: `seeded tag ${i}`,
      nameHlc: '',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      deletedHlc: null,
      color: 'blue',
      colorHlc: '',
    }))
    localStorage.setItem('devot.test.tags', JSON.stringify(tags))
    localStorage.setItem(
      'devot.test.noteTags',
      JSON.stringify(
        notes.flatMap((n) =>
          tags.map((tag) => ({ noteId: n.id, tagId: tag.id, present: true, hlc: '' })),
        ),
      ),
    )
  })
  await page.reload()
  await openFirstNote(page)
  const chips = note(page).locator('.phone-chip-target')
  await expect(chips).toHaveCount(11)
  const boxes = await chips.evaluateAll((targets) =>
    targets.map((target) => {
      const box = target.getBoundingClientRect()
      const face = target.firstElementChild!.getBoundingClientRect()
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        height: box.height,
        face: face.height,
        offset: face.top + face.height / 2 - (box.top + box.height / 2),
      }
    }),
  )
  expect(new Set(boxes.map((box) => box.top)).size).toBeGreaterThan(1)
  for (const box of boxes) {
    expect(box.height).toBe(44)
    expect(box.face).toBe(30)
    expect(Math.abs(box.offset)).toBeLessThanOrEqual(0.5)
  }
  boxes.forEach((a, i) => {
    for (const b of boxes.slice(i + 1)) {
      const apart = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top
      expect(apart).toBe(true)
    }
  })
})

test.describe('under Reduce Motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } })

  test('a sheet only crossfades', async ({ page }) => {
    await expect(page.locator(':root')).toHaveAttribute('data-motion', 'reduced')
    await note(page).locator('.phone-chip-target').nth(1).click()
    const sheet = page.getByRole('dialog', { name: 'Status' })
    await expect(sheet).toHaveCSS('opacity', '1')
    const seen = await sheet.evaluate((el) => ({
      transform: getComputedStyle(el).transform,
      property: getComputedStyle(el).transitionProperty,
    }))
    expect(seen).toEqual({ transform: 'none', property: 'opacity' })
  })
})

test.describe('which mode a note opens in', () => {
  const LINKING = '0192a6f0-0000-7000-8000-00000000abc1'
  const TARGET = '0192a6f0-0000-7000-8000-00000000abc2'
  const BLANK = '0192a6f0-0000-7000-8000-00000000abc3'

  const modeOf = (page: Page) => note(page).locator('.phone-note-body')
  const preview = (page: Page) => note(page).locator('.phone-note-preview')
  const heading = (page: Page) => note(page).locator('.phone-note-heading')
  const back = (page: Page) => note(page).getByRole('button', { name: 'Back', exact: true })

  const ydocOf = (body: string) => {
    const doc = new Y.Doc()
    doc.getText('body').insert(0, body)
    return Array.from(Y.encodeStateAsUpdate(doc))
  }

  const seedAndOpen = async (page: Page, title: string) => {
    const seeds = [
      {
        id: LINKING,
        title: 'Linking',
        bodyMd: `[Target](devot://note/${TARGET}) and [Blank](devot://note/${BLANK})`,
      },
      { id: TARGET, title: 'Target', bodyMd: 'Target body' },
      { id: BLANK, title: 'Blank', bodyMd: '' },
    ].map((seed) => ({ ...seed, ydoc: ydocOf(seed.bodyMd) }))
    await page.evaluate((notes) => {
      const hlc = '0000000000000001-0000-test'
      localStorage.setItem(
        'devot.test.notes',
        JSON.stringify(
          notes.map((seed, i) => ({
            ...seed,
            titleHlc: hlc,
            bookId: null,
            bookHlc: '',
            status: 'none',
            statusHlc: '',
            pinned: false,
            pinnedHlc: '',
            bodyVersion: 1,
            createdAt: 1_000 + i,
            updatedAt: 1_000 + i,
            deletedAt: null,
            deletedHlc: null,
          })),
        ),
      )
    }, seeds)
    await page.goto('/')
    await openPhoneNote(page, title)
    await expect(note(page).locator('.cm-content')).toBeAttached()
  }

  // The phone has no outside-merge path into an open note yet; replacing the document through the
  // hidden editor's view sends the same text report an outside change would.
  const replaceBody = (page: Page, body: string) =>
    note(page)
      .locator('.cm-content')
      .evaluate((content, next) => {
        const view = (content as unknown as { cmTile: { view: EditorViewLike } }).cmTile.view
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
      }, body)

  test('following a link from Preview lands in Preview, with its own text', async ({ page }) => {
    await seedAndOpen(page, 'Linking')
    await expect(modeOf(page)).toHaveAttribute('data-mode', 'preview')
    await preview(page).getByRole('link', { name: 'Target' }).click()
    await expect(heading(page)).toHaveValue('Target')
    await expect(preview(page)).toContainText('Target body')
    await expect(modeOf(page)).toHaveAttribute('data-mode', 'preview')
  })

  test('an empty note lands in Edit, opened directly or by a link', async ({ page }) => {
    await seedAndOpen(page, 'Blank')
    await expect(modeOf(page)).toHaveAttribute('data-mode', 'edit')
    await note(page).getByRole('button', { name: 'Back', exact: true }).click()
    await expect(note(page)).toHaveCount(0)
    await openPhoneNote(page, 'Linking')
    await expect(preview(page).getByRole('link', { name: 'Blank' })).toBeVisible()
    await preview(page).getByRole('link', { name: 'Blank' }).click()
    await expect(heading(page)).toHaveValue('Blank')
    await expect(modeOf(page)).toHaveAttribute('data-mode', 'edit')
  })

  test('a body emptied and refilled while in Preview leaves the mode alone', async ({ page }) => {
    await seedAndOpen(page, 'Target')
    await expect(preview(page)).toContainText('Target body')
    await replaceBody(page, '')
    await expect(preview(page)).not.toContainText('Target body')
    await expect(modeOf(page)).toHaveAttribute('data-mode', 'preview')
    await replaceBody(page, 'Filled again')
    await expect(preview(page)).toContainText('Filled again')
    await expect(modeOf(page)).toHaveAttribute('data-mode', 'preview')
  })

  test('a note being edited stays in Edit when its body goes empty', async ({ page }) => {
    await seedAndOpen(page, 'Target')
    await note(page).getByRole('button', { name: 'Edit', exact: true }).click()
    await replaceBody(page, '')
    await expect(note(page).locator('.cm-content')).not.toContainText('Target body')
    await expect(modeOf(page)).toHaveAttribute('data-mode', 'edit')
  })

  test('Back returns to the linking note in the mode it was left in, then leaves', async ({
    page,
  }) => {
    await seedAndOpen(page, 'Linking')
    await preview(page).getByRole('link', { name: 'Target' }).click()
    await expect(heading(page)).toHaveValue('Target')
    await note(page).getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(modeOf(page)).toHaveAttribute('data-mode', 'edit')

    await back(page).click()
    await expect(heading(page)).toHaveValue('Linking')
    await expect(modeOf(page)).toHaveAttribute('data-mode', 'preview')
    await expect(preview(page).getByRole('link', { name: 'Target' })).toBeVisible()

    await back(page).click()
    await expect(note(page)).toHaveCount(0)
  })
})

test('an unbroken long tag stays on screen, cut with an ellipsis, in a 44 target', async ({
  page,
}) => {
  await page.evaluate(() => {
    const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as { id: string }[]
    const tag = {
      id: 'long-tag',
      name: 'abcdefghijklmnop'.repeat(4),
      nameHlc: '',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      deletedHlc: null,
      color: 'blue',
      colorHlc: '',
    }
    localStorage.setItem('devot.test.tags', JSON.stringify([tag]))
    localStorage.setItem(
      'devot.test.noteTags',
      JSON.stringify(notes.map((n) => ({ noteId: n.id, tagId: tag.id, present: true, hlc: '' }))),
    )
  })
  await page.reload()
  await openFirstNote(page)
  const target = note(page).locator('.phone-chip-target:has([data-tag])')
  await expect(target).toHaveCount(1)
  const box = (await target.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(box.height).toBeGreaterThanOrEqual(44)
  const text = target.locator('.phone-chip-text')
  await expect(text).toHaveCSS('text-overflow', 'ellipsis')
  expect(await text.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
})

test('the tag field is concentric with the sheet', async ({ page }) => {
  await note(page).locator('.phone-chip-target:has(.phone-chip-dashed)').click()
  const field = page
    .getByRole('dialog', { name: 'Tags' })
    .getByRole('textbox', { name: 'Tag name' })
  await expect(field).toBeVisible()
  const { radius, expected } = await field.evaluate((el) => {
    const probe = document.createElement('div')
    probe.style.width = 'calc(var(--radius-phone-sheet) - var(--size-phone-sheet-pad))'
    el.parentElement!.append(probe)
    const width = probe.getBoundingClientRect().width
    probe.remove()
    return { radius: parseFloat(getComputedStyle(el).borderTopLeftRadius), expected: width }
  })
  expect(radius).toBeCloseTo(expected, 0)
})

test('a New Note picked from [[ and then not linked is purged, not left in the Trash (#531)', async ({
  page,
}) => {
  await note(page).getByRole('button', { name: 'Edit', exact: true }).click()
  const content = note(page).locator('.cm-content')
  await content.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' [[')
  await page.keyboard.insertText('Plan B')
  const option = page
    .locator('.cm-tooltip-autocomplete')
    .getByRole('option', { name: 'New Note “Plan B”' })
  await expect(option).toBeVisible()
  // Past CodeMirror's interactionDelay, during which a pick is ignored.
  await page.waitForTimeout(150)
  await page.evaluate(() => localStorage.setItem('devot.test.delayNoteWrites', 'hold'))
  await option.click()
  // The brackets change under the pick, so the note made for it is not linked.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('!')
  await page.evaluate(() => localStorage.removeItem('devot.test.delayNoteWrites'))
  // A purge clears the title; a note only trashed keeps it.
  const purged = () =>
    page.evaluate(() => {
      const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
        title: string
        purgedAt?: number
      }[]
      return {
        purged: notes.some((n) => n.purgedAt !== undefined),
        kept: notes.some((n) => n.title === 'Plan B'),
      }
    })
  await expect.poll(purged).toEqual({ purged: true, kept: false })
  await expect(content).toContainText('[[Plan !B]]')
})
