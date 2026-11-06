import type { Page } from '@playwright/test'
import * as Y from 'yjs'
import { expect, test } from './fixtures'

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
  await page
    .getByRole('navigation', { name: 'Tabs' })
    .getByRole('button', { name: 'Notes' })
    .click()
  await page.locator('[data-section="recent"] .phone-note-open').first().click()
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

test('the mode toggle swaps Edit and Preview, and the sparkle leaves in Preview', async ({
  page,
}) => {
  const toEdit = note(page).getByRole('button', { name: 'Edit', exact: true })
  const toPreview = note(page).getByRole('button', { name: 'Preview', exact: true })
  const ai = note(page).getByRole('button', { name: 'Suggest with AI' })
  await expect(note(page).locator('.phone-note-preview')).toHaveAttribute('data-shown', 'true')
  await expect(ai).toHaveCount(0)
  await toEdit.click()
  await expect(ai).toBeVisible()
  await expect(note(page).locator('.phone-note-preview')).not.toHaveAttribute('data-shown', 'true')
  await toPreview.click()
  await expect(note(page).locator('.phone-note-preview')).toHaveAttribute('data-shown', 'true')
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

test('bottom controls reach 44 points', async ({ page }) => {
  await note(page).getByRole('button', { name: 'Edit', exact: true }).click()
  for (const name of ['Find in Note', 'Suggest with AI', 'Previous Note', 'Next Note']) {
    const box = (await note(page).getByRole('button', { name }).boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
  }
})

test('find uses the editor: it counts matches, steps and closes', async ({ page }) => {
  await note(page).getByRole('button', { name: 'Find in Note' }).click()
  const field = note(page).getByRole('searchbox', { name: 'Find in Note' })
  await expect(note(page).locator('.phone-note-bottom')).toHaveAttribute('data-hidden', 'true')
  await field.fill('e')
  await expect(note(page).locator('.phone-find-count')).toHaveText(/^\d+ of \d+$/)
  await expect(note(page).locator('.cm-find-match').first()).toBeAttached()
  await note(page).getByRole('button', { name: 'Next match' }).click()
  await note(page).getByRole('button', { name: 'Close find' }).click()
  await expect(field).toHaveCount(0)
  await expect(note(page).locator('.cm-find-match')).toHaveCount(0)
  await expect(note(page).locator('.phone-note-bottom')).not.toHaveAttribute('data-hidden', 'true')
})

test('typing shows the formatting bar on the keyboard and hides the bottom bar', async ({
  page,
}) => {
  await note(page).getByRole('button', { name: 'Edit', exact: true }).click()
  await page.evaluate(() => {
    const viewport = window.visualViewport!
    Object.defineProperty(viewport, 'height', { value: window.innerHeight - 300 })
    viewport.dispatchEvent(new Event('resize'))
  })
  await expect(note(page).locator('.phone-note-bottom')).toHaveAttribute('data-hidden', 'true')
  const bar = note(page).getByRole('toolbar', { name: 'Formatting' })
  await expect(note(page).locator('.phone-accessory')).toHaveAttribute('data-shown', 'true')
  await expect(bar.getByRole('button')).toHaveCount(7)
  await expect(note(page).getByRole('button', { name: 'Hide keyboard' })).toBeVisible()
})

test('note info has stats in mono, icon rows and a working Move to Trash', async ({ page }) => {
  await note(page).getByRole('button', { name: 'Note Info' }).click()
  const sheet = page.getByRole('dialog', { name: 'Note Info' })
  await expect(sheet.locator('.phone-info-stat dd').first()).toHaveClass(/phone-figures/)
  for (const row of ['Notebook', 'Created', 'Modified']) {
    await expect(
      sheet.locator('.phone-grouped-row').filter({ hasText: row }).locator('.phone-row-icon'),
    ).toBeVisible()
  }
  await expect(sheet.getByText('Revision history')).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
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

test('hidden note bars are inert', async ({ page }) => {
  const bottom = note(page).locator('.phone-note-bottom')
  const accessory = note(page).locator('.phone-accessory')
  const focusable = (bar: typeof bottom) =>
    bar
      .locator('button:not([disabled])')
      .first()
      .evaluate((button) => {
        button.focus()
        return button.ownerDocument.activeElement === button
      })
  await expect(accessory).toHaveAttribute('inert')
  await expect(bottom).not.toHaveAttribute('inert')
  expect(await focusable(accessory)).toBe(false)
  await note(page).getByRole('button', { name: 'Edit', exact: true }).click()
  await page.evaluate(() => {
    const viewport = window.visualViewport!
    Object.defineProperty(viewport, 'height', { value: window.innerHeight - 300 })
    viewport.dispatchEvent(new Event('resize'))
  })
  await expect(bottom).toHaveAttribute('inert')
  await expect(accessory).not.toHaveAttribute('inert')
  expect(await focusable(bottom)).toBe(false)
  expect(await focusable(accessory)).toBe(true)
})

test('note info metadata is plain rows at full opacity, with dates in figures', async ({
  page,
}) => {
  await note(page).getByRole('button', { name: 'Note Info' }).click()
  const sheet = page.getByRole('dialog', { name: 'Note Info' })
  for (const label of ['Notebook', 'Created', 'Modified']) {
    await expect(sheet.getByRole('button', { name: new RegExp(`^${label}`) })).toHaveCount(0)
    const row = sheet.locator('.phone-grouped-row').filter({ hasText: label }).locator('> *')
    expect(await row.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  }
  for (const label of ['Created', 'Modified']) {
    await expect(
      sheet
        .locator('.phone-grouped-row')
        .filter({ hasText: label })
        .locator('.phone-grouped-count'),
    ).toHaveClass(/phone-figures/)
  }
  await expect(sheet.getByRole('button', { name: 'Move to Trash' })).toBeEnabled()
})

test('note info at twice the text size reflows without clipping', async ({ page }) => {
  await atDoubleText(page)
  await note(page).getByRole('button', { name: 'Note Info' }).click()
  const sheet = page.getByRole('dialog', { name: 'Note Info' })
  const stats = sheet.locator('.phone-info-stat')
  await expect(stats).toHaveCount(4)
  const lefts = await stats.evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().left),
  )
  expect(new Set(lefts).size).toBe(2)
  const clipped = await sheet
    .locator('.phone-card')
    .evaluateAll((cards) => cards.filter((card) => card.scrollHeight > card.clientHeight).length)
  expect(clipped).toBe(0)
  const row = sheet.locator('.phone-grouped-row').filter({ hasText: 'Notebook' })
  const [label, value] = await Promise.all([
    row.locator('.phone-grouped-label').boundingBox(),
    row.locator('.phone-grouped-count').boundingBox(),
  ])
  expect(value!.y).toBeGreaterThanOrEqual(label!.y + label!.height - 1)
  expect(label!.height).toBeLessThan(2 * 17 * 2)
})

test.describe('under Reduce Motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } })

  test('a sheet and the bottom bar only crossfade', async ({ page }) => {
    await expect(page.locator(':root')).toHaveAttribute('data-motion', 'reduced')
    const bottom = note(page).locator('.phone-note-bottom')
    await note(page).getByRole('button', { name: 'Find in Note' }).click()
    await expect(bottom).toHaveAttribute('data-hidden', 'true')
    const bar = await bottom.evaluate((el) => ({
      translate: getComputedStyle(el).translate,
      property: getComputedStyle(el).transitionProperty,
    }))
    expect(bar).toEqual({ translate: 'none', property: 'opacity' })
    await note(page).getByRole('button', { name: 'Close find' }).click()
    await note(page).getByRole('button', { name: 'Note Info' }).click()
    const sheet = page.getByRole('dialog', { name: 'Note Info' })
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
  const previous = (page: Page) => note(page).getByRole('button', { name: 'Previous Note' })
  const nextNote = (page: Page) => note(page).getByRole('button', { name: 'Next Note' })

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
    await page
      .getByRole('navigation', { name: 'Tabs' })
      .getByRole('button', { name: 'Notes' })
      .click()
    await page.locator('.phone-note-open', { hasText: title }).first().click()
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
    await page.locator('.phone-note-open', { hasText: 'Linking' }).first().click()
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

  test('Back and Forward return to each note in the mode it was left in', async ({ page }) => {
    await seedAndOpen(page, 'Linking')
    await preview(page).getByRole('link', { name: 'Target' }).click()
    await expect(heading(page)).toHaveValue('Target')
    await note(page).getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(modeOf(page)).toHaveAttribute('data-mode', 'edit')

    await previous(page).click()
    await expect(heading(page)).toHaveValue('Linking')
    await expect(modeOf(page)).toHaveAttribute('data-mode', 'preview')
    await expect(preview(page).getByRole('link', { name: 'Target' })).toBeVisible()

    await nextNote(page).click()
    await expect(heading(page)).toHaveValue('Target')
    await expect(note(page).locator('.cm-content')).toContainText('Target body')
    await expect(modeOf(page)).toHaveAttribute('data-mode', 'edit')
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

test('the find count draws its numbers as figures and its words in the body font', async ({
  page,
}) => {
  await note(page).getByRole('button', { name: 'Find in Note' }).click()
  await note(page).getByRole('searchbox', { name: 'Find in Note' }).fill('e')
  const count = note(page).locator('.phone-find-count')
  await expect(count).toHaveText(/^\d+ of \d+$/)
  await expect(count).not.toHaveCSS('font-family', /mono|Menlo/i)
  const figures = count.locator('.phone-figures')
  await expect(figures).toHaveCount(2)
  for (const figure of await figures.all()) {
    await expect(figure).toHaveText(/^\d+$/)
    await expect(figure).toHaveCSS('font-family', /mono|Menlo/i)
  }
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
