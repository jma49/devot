import type { Page } from '@playwright/test'
import { expect, symbolRequests, test, openApp } from './fixtures'

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Format' })
const button = (page: Page, name: string) => toolbar(page).getByRole('button', { name })
const lines = (page: Page) => page.locator('.cm-line').allTextContents()

async function newNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  // The title clears before the new note's editor replaces the last one.
  await expect(body(page)).toHaveText('')
  await body(page).click()
  await page.keyboard.insertText(text)
}

type Box = { x: number; y: number; width: number; height: number }

/** Double-clicks `word` on line `n` (from 1): a real mouse word selection, the same on every platform. */
async function selectWord(page: Page, n: number, word: string) {
  // A shown toolbar can cover the word. Escape again if the first came before
  // the keyboard was back in the editor (a dialog just closed, say).
  await expect(async () => {
    if (await toolbar(page).isVisible()) await page.keyboard.press('Escape')
    await expect(toolbar(page)).toBeHidden({ timeout: 500 })
  }).toPass()
  // The editor may scroll on the next frame (after Home, say): measure until
  // the word sits still inside the scroller.
  const at = await body(page).evaluate(
    async (content, [index, target]) => {
      const scroller = content.closest('.cm-scroller')
      const measure = () => {
        // Lines are drawn again as the editor scrolls: look the line up each time.
        const line = content.querySelectorAll('.cm-line')[index]
        if (!line) return null
        const texts = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
        for (let node = texts.nextNode(); node; node = texts.nextNode()) {
          const i = (node.nodeValue ?? '').indexOf(target)
          if (i < 0) continue
          const range = document.createRange()
          range.setStart(node, i)
          range.setEnd(node, i + target.length)
          const r = range.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        }
        return null
      }
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const inside = (p: { x: number; y: number }) => {
        const box = scroller?.getBoundingClientRect()
        return !box || (p.x > box.x && p.x < box.right && p.y > box.y && p.y < box.bottom)
      }
      let last = measure()
      for (let tries = 0; tries < 120; tries++) {
        await frame()
        const now = measure()
        if (!now) return null
        if (last && now.x === last.x && now.y === last.y && inside(now)) return now
        last = now
      }
      return null
    },
    [n - 1, word] as const,
  )
  if (!at) throw new Error('E_TEST_NO_WORD')
  await page.mouse.dblclick(at.x, at.y)
  await expect(toolbar(page)).toBeVisible()
  const selected = page.locator('.cm-selectionBackground')
  await expect(selected).toHaveCount(1)
  // A selection that ends at the row paints out to the column, so the tint is
  // wider than the word. The word's centre still sits inside it.
  await expect
    .poll(async () => {
      const box = await selected.boundingBox()
      return (
        !!box &&
        at.x >= box.x - 1 &&
        at.x <= box.x + box.width + 1 &&
        at.y >= box.y - 1 &&
        at.y <= box.y + box.height + 1
      )
    }, `the selection covers "${word}"`)
    .toBe(true)
}

async function selectAll(page: Page) {
  await page.keyboard.press('ControlOrMeta+a')
  await expect(toolbar(page)).toBeVisible()
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

async function expectBesideSelection(page: Page): Promise<Box> {
  await expect(toolbar(page)).toBeVisible()
  const selected = page.locator('.cm-selectionBackground')
  await expect(selected.first()).toBeVisible()
  // CodeMirror measures in the next frame.
  await page.evaluate(() => new Promise((done) => window.requestAnimationFrame(() => done(null))))
  const bar = await toolbar(page).boundingBox()
  const boxes = await selected.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }),
  )
  if (!bar) throw new Error('E_TEST_NO_TOOLBAR_BOX')
  for (const box of boxes) expect(overlaps(bar, box)).toBe(false)
  const top = Math.min(...boxes.map((b) => b.y))
  const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  const gapAbove = top - (bar.y + bar.height)
  const gapBelow = bar.y - bottom
  expect(
    (gapAbove >= -1 && gapAbove < 20) || (gapBelow >= -1 && gapBelow < 20),
    `toolbar ${bar.y}-${bar.y + bar.height}, selection ${top}-${bottom}`,
  ).toBe(true)
  return bar
}

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('the toolbar shows for a selection: one outlined box of named SF Symbol buttons in four groups', async ({
  page,
}) => {
  await newNote(page, 'alpha beta gamma')
  await expect(toolbar(page)).toBeHidden()
  await selectAll(page)
  const names: [string, string][] = [
    ['Heading', 'number'],
    ['Bold', 'bold'],
    ['Italic', 'italic'],
    ['Strikethrough', 'strikethrough'],
    ['Highlight', 'highlighter'],
    ['Link', 'link'],
    ['Inline Code', 'chevron.left.forwardslash.chevron.right'],
    ['Code Block', 'curlybraces'],
    ['Bulleted List', 'list.bullet'],
    ['Numbered List', 'list.number'],
    ['Task List', 'checkmark.square'],
    ['Quote', 'text.quote'],
    ['Alert', 'megaphone'],
    ['Edit with AI', 'sparkles'],
  ]
  await expect(toolbar(page).getByRole('button')).toHaveCount(names.length)
  for (const [name, symbol] of names) {
    await expect(button(page, name).locator('.icon')).toHaveAttribute('data-symbol', symbol)
    await expect(button(page, name)).not.toHaveAttribute('title')
  }
  const order = await toolbar(page)
    .locator('> *')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.getAttribute('role')))
  expect(order).toEqual([
    ...names.slice(0, 6).map((n) => n[0]),
    'separator',
    ...names.slice(6, 8).map((n) => n[0]),
    'separator',
    ...names.slice(8, 13).map((n) => n[0]),
    'separator',
    names[13]![0],
  ])
  const icons = toolbar(page).locator('button [data-symbol]')
  await expect(icons.first()).toHaveCSS('-webkit-mask-image', /^url\(/)
  const sizes = await icons.evaluateAll((all) =>
    all.map((el) => {
      const box = el.getBoundingClientRect()
      return `${box.width}x${box.height}`
    }),
  )
  expect(sizes.length).toBeGreaterThan(4)
  expect(new Set(sizes)).toEqual(new Set(['18x18']))

  const bar = page.locator('.cm-format-toolbar')
  await expect(bar).toBeVisible()
  const look = await bar.evaluate((el) => {
    const style = (target: Element | null) => getComputedStyle(target!)
    const root = el
    const box = root.querySelector('.cm-float-notch')!.getBoundingClientRect()
    const icon = style(root.querySelector('.cm-float-button .icon'))
    return {
      shadow: style(el).boxShadow,
      filter: style(el).filter,
      notch: [box.width, box.height],
      size: [icon.width, icon.height],
      mask: icon.getPropertyValue('mask-size') || icon.getPropertyValue('-webkit-mask-size'),
    }
  })
  // The outline is the glass rim's half-pixel ring in the box shadow (no spread blur), under the notch.
  expect(look.shadow).toMatch(/0px 0px 0px 0\.5px/)
  expect(look.filter).toBe('none')
  expect(look.notch).toEqual([12, 6])
  // Whole pixels, and the mask fills the box exactly, so the glyph is scaled
  // into it rather than overhanging.
  for (const px of look.size) expect(Number.isInteger(Number.parseFloat(px ?? ''))).toBe(true)
  expect(look.mask).toBe('100% 100%')
  const calls = await page.evaluate(() => window.devotIpcCalls)
  expect(symbolRequests(calls)).toContain('bold@14')
})

test('a button tooltip shows its name and key; Heading and Highlight have no key', async ({
  page,
}) => {
  await newNote(page, 'alpha beta gamma')
  await selectAll(page)
  const tip = page.getByRole('tooltip')
  await button(page, 'Bold').hover()
  await expect(tip).toBeVisible()
  await expect(tip.locator('.cm-float-tip-title')).toHaveText('Bold')
  await expect(tip.locator('kbd')).toHaveText('\u2318B')
  await button(page, 'Code Block').hover()
  await expect(tip.locator('.cm-float-tip-title')).toHaveText('Code Block')
  await expect(tip.locator('kbd')).toHaveText('\u21e7\u2318C')
  for (const name of ['Heading', 'Highlight']) {
    await button(page, name).hover()
    await expect(tip.locator('.cm-float-tip-title')).toHaveText(name)
    await expect(tip.locator('kbd')).toHaveCount(0)
  }
  await page.mouse.move(1, 1)
  await expect(tip).toBeHidden()
})

test('the toolbar hides on Escape, a collapsed selection and typing', async ({ page }) => {
  await newNote(page, 'alpha beta gamma')
  await selectAll(page)
  await page.keyboard.press('Escape')
  await expect(toolbar(page)).toBeHidden()
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(toolbar(page)).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(toolbar(page)).toBeHidden()
  await selectAll(page)
  await page.keyboard.type('x')
  await expect(toolbar(page)).toBeHidden()
  expect(await lines(page)).toEqual(['x'])
})

test('the toolbar follows the selection and never covers it', async ({ page }) => {
  await newNote(page, 'first line\nsecond line of the note\nthird line\nfourth line')
  // The first line: the toolbar reaches up over the meta line, still above it.
  await selectWord(page, 1, 'first')
  const onFirst = await expectBesideSelection(page)
  const firstLine = (await page.locator('.cm-selectionBackground').first().boundingBox())!
  expect(onFirst.y + onFirst.height).toBeLessThanOrEqual(firstLine.y + 1)

  await selectWord(page, 3, 'third')
  const atStart = await expectBesideSelection(page)
  await selectWord(page, 3, 'line')
  const atEnd = await expectBesideSelection(page)
  expect(atEnd.x).toBeGreaterThan(atStart.x + 20)

  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expectBesideSelection(page)
})

test('the buttons apply and remove each format', async ({ page }) => {
  await newNote(page, 'alpha beta')
  const inline: [string, string][] = [
    ['Bold', '**alpha beta**'],
    ['Italic', '*alpha beta*'],
    ['Strikethrough', '~~alpha beta~~'],
    ['Highlight', '<mark>alpha beta</mark>'],
    ['Inline Code', '`alpha beta`'],
  ]
  for (const [name, formatted] of inline) {
    await selectAll(page)
    await expect(button(page, name)).toHaveAttribute('aria-pressed', 'false')
    await button(page, name).click()
    expect(await lines(page), name).toEqual([formatted])
    await expect(button(page, name)).toHaveAttribute('aria-pressed', 'true')
    await button(page, name).click()
    expect(await lines(page), name).toEqual(['alpha beta'])
  }
  // The body keeps focus: typing replaces the selection.
  await page.keyboard.type('done')
  expect(await lines(page)).toEqual(['done'])

  await newNote(page, 'alpha\nbeta')
  const block: [string, string[]][] = [
    ['Code Block', ['```', 'alpha', 'beta', '```']],
    ['Bulleted List', ['* alpha', '* beta']],
    ['Numbered List', ['1. alpha', '2. beta']],
    ['Task List', ['* [ ] alpha', '* [ ] beta']],
    ['Quote', ['> alpha', '> beta']],
  ]
  for (const [name, formatted] of block) {
    await selectAll(page)
    await expect(button(page, name)).toHaveAttribute('aria-pressed', 'false')
    await button(page, name).click()
    expect(await lines(page), name).toEqual(formatted)
    // The lines stay selected, so the toolbar stays and shows the format as on.
    await expect(button(page, name)).toHaveAttribute('aria-pressed', 'true')
    await button(page, name).click()
    expect(await lines(page), name).toEqual(['alpha', 'beta'])
  }
})

test('the heading button raises the level and puts the caret at the end of the line', async ({
  page,
}) => {
  await newNote(page, 'Plans')
  await selectAll(page)
  await button(page, 'Heading').click()
  expect(await lines(page)).toEqual(['# Plans'])
  await expect(toolbar(page)).toBeHidden()
  await page.keyboard.insertText('!')
  expect(await lines(page)).toEqual(['# Plans!'])
  await selectWord(page, 1, 'Plans')
  await button(page, 'Heading').click()
  expect(await lines(page)).toEqual(['## Plans!'])
})

test('the link button asks for the address in a dialog and inserts the link', async ({ page }) => {
  await newNote(page, 'Read the docs today')
  await selectWord(page, 1, 'docs')
  await button(page, 'Link').click()
  const dialog = page.getByRole('dialog', { name: 'Insert a link' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: 'Text' })).toHaveValue('docs')
  const url = dialog.getByRole('textbox', { name: 'URL' })
  await expect(url).toBeFocused()
  await expect(url).toHaveAttribute('placeholder', 'https://')
  await page.keyboard.insertText('https://example.com')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  expect(await lines(page)).toEqual(['Read the [docs](https://example.com) today'])
  await page.keyboard.insertText('!')
  expect(await lines(page)).toEqual(['Read the [docs](https://example.com)! today'])

  await selectWord(page, 1, 'today')
  await button(page, 'Link').click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(await lines(page)).toEqual(['Read the [docs](https://example.com)! today'])

  await selectWord(page, 1, 'docs')
  await button(page, 'Link').click()
  await expect(dialog).toBeHidden()
  expect(await lines(page)).toEqual(['Read the docs! today'])
})

test('every format has a shortcut that works without the toolbar', async ({ page }) => {
  await newNote(page, 'word')
  const cases: [string, string[]][] = [
    ['ControlOrMeta+b', ['**word**']],
    ['ControlOrMeta+i', ['*word*']],
    ['ControlOrMeta+KeyU', ['~~word~~']],
    ['ControlOrMeta+Alt+KeyE', ['`word`']],
    ['ControlOrMeta+Shift+KeyC', ['```', 'word', '```']],
    ['ControlOrMeta+Shift+KeyL', ['* word']],
    ['ControlOrMeta+Shift+KeyO', ['1. word']],
    ['ControlOrMeta+Shift+KeyT', ['* [ ] word']],
    ['ControlOrMeta+Quote', ['> word']],
  ]
  for (const [keys, formatted] of cases) {
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Escape')
    await expect(toolbar(page)).toBeHidden()
    await page.keyboard.press(keys)
    expect(await lines(page), keys).toEqual(formatted)
    await page.keyboard.press(keys)
    expect(await lines(page), keys).toEqual(['word'])
  }
  for (const level of [1, 2, 3, 4, 5, 6]) {
    await page.keyboard.press(`${level <= 4 ? 'ControlOrMeta' : 'ControlOrMeta+Alt'}+Digit${level}`)
    expect(await lines(page)).toEqual([`${'#'.repeat(level)} word`])
  }
  await page.keyboard.press('ControlOrMeta+Alt+Digit6')
  expect(await lines(page)).toEqual(['word'])

  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+Alt+k')
  await page.keyboard.insertText('u')
  expect(await lines(page)).toEqual(['[word](u)'])
})

test('each format is one undo step', async ({ page }) => {
  await newNote(page, 'alpha beta')
  await selectAll(page)
  await button(page, 'Bold').click()
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  expect(await lines(page)).toEqual(['**alpha beta**!'])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['**alpha beta**'])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['alpha beta'])

  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+Digit2')
  expect(await lines(page)).toEqual(['## alpha beta'])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['alpha beta'])

  await newNote(page, 'a\nb\nc')
  await selectAll(page)
  await button(page, 'Numbered List').click()
  await button(page, 'Quote').click()
  expect(await lines(page)).toEqual(['> 1. a', '> 2. b', '> 3. c'])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['1. a', '2. b', '3. c'])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['a', 'b', 'c'])
})

test('Edit > Undo also takes back one format at a time', async ({ page }) => {
  await newNote(page, 'alpha beta')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+i')
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  // The menu item reaches the page as a `historyUndo` input event, handled by CodeMirror's history
  // before the Yjs binding; format transactions isolate their history, so each is its own step.
  const menuUndo = () =>
    body(page).evaluate((el) => {
      const Input = window.InputEvent
      el.dispatchEvent(
        new Input('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true }),
      )
    })
  await menuUndo()
  await expect.poll(() => lines(page)).toEqual(['*alpha beta*'])
  await menuUndo()
  await expect.poll(() => lines(page)).toEqual(['alpha beta'])
})

const manyLines = Array.from({ length: 90 }, (_, i) => `line ${i + 1} of the note`).join('\n')
const editorBox = (page: Page) => page.locator('[data-devot-part="editor-scroll"]')

test('the toolbar sits above the selection start, on the first line too, and hides while it is scrolled out', async ({
  page,
}) => {
  await newNote(page, manyLines)
  await page.keyboard.press('ControlOrMeta+Home')
  await selectWord(page, 6, 'note')
  const start = (await page.locator('.cm-selectionBackground').first().boundingBox())!
  const bar = (await toolbar(page).boundingBox())!
  expect(bar.y + bar.height).toBeLessThanOrEqual(start.y + 1)
  await expect(toolbar(page)).toBeInViewport()
  await editorBox(page).evaluate((el) => {
    el.scrollTop = 1500
  })
  await expect(toolbar(page)).not.toBeInViewport()
  await editorBox(page).evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(toolbar(page)).toBeInViewport()

  await selectWord(page, 1, 'line')
  const first = (await page.locator('.cm-selectionBackground').first().boundingBox())!
  const onFirst = await expectBesideSelection(page)
  expect(onFirst.y + onFirst.height).toBeLessThanOrEqual(first.y + 1)
  const top = (await page.locator('.editor-toolbar').boundingBox())!
  expect(onFirst.y).toBeGreaterThanOrEqual(top.y + top.height)
  await expect(toolbar(page)).toBeInViewport({ ratio: 1 })
})

test('the notch keeps pointing at the selection start when the bar is held back at the edge', async ({
  page,
}) => {
  const words = Array.from({ length: 70 }, (_, i) => `w${String(i + 10)}`)
  await newNote(page, `intro\n${words.join(' ')}`)
  const word = await page
    .locator('.cm-line')
    .nth(1)
    .evaluate((line, all) => {
      const node = document.createTreeWalker(line, NodeFilter.SHOW_TEXT).nextNode()
      if (!node) return null
      let best: string | null = null
      let top: number | null = null
      for (const w of all) {
        const at = (node.nodeValue ?? '').indexOf(w)
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + w.length)
        const r = range.getBoundingClientRect()
        top ??= r.top
        if (r.top > top + 1) break
        best = w
      }
      return best
    }, words)
  if (!word) throw new Error('E_TEST_NO_WORD')
  await selectWord(page, 2, word)
  const bar = page.locator('.cm-format-toolbar')
  await expect
    .poll(async () => {
      const [placed, sel] = await Promise.all([
        bar.evaluate((el) => {
          const r = el.getBoundingClientRect()
          const value = window.getComputedStyle(el).getPropertyValue('--float-notch-x')
          return { left: r.x, notch: Number.parseFloat(value) }
        }),
        page.locator('.cm-selectionBackground').first().boundingBox(),
      ])
      if (!sel || Number.isNaN(placed.notch)) return false
      // The bar is held back (the notch is past its resting place) and still on the start.
      return placed.notch > 20 && Math.abs(placed.left + placed.notch - sel.x) < 2
    })
    .toBe(true)
})

test('a tooltip on the first button stays inside the editor, its notch on the button', async ({
  page,
}) => {
  await newNote(page, 'alpha beta gamma')
  await page.keyboard.press('ControlOrMeta+Home')
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
  const heading = button(page, 'Heading')
  await heading.hover()
  const tip = page.getByRole('tooltip')
  await expect(tip).toBeVisible()

  const host = await page.locator('[data-devot-part="editor-body"]').boundingBox()
  const [tipBox, buttonBox] = await Promise.all([tip.boundingBox(), heading.boundingBox()])
  if (!host || !tipBox || !buttonBox) throw new Error('missing boxes')
  expect(tipBox.x).toBeGreaterThanOrEqual(host.x + 3)
  expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(host.x + host.width - 3)

  const notchLeft = await tip.evaluate((el) => {
    const view = window
    return Number.parseFloat(view.getComputedStyle(el, '::before').left)
  })
  // The notch's box is 8px (space-4); its centre is 4px past the reported left.
  const notchCenter = tipBox.x + notchLeft + 4
  expect(Math.abs(notchCenter - (buttonBox.x + buttonBox.width / 2))).toBeLessThan(2)
})

test('a toolbar button tooltip waits, then shows above its button; a focused button gives focus back', async ({
  page,
}) => {
  await newNote(page, manyLines)
  await page.keyboard.press('ControlOrMeta+Home')
  await selectWord(page, 12, 'note')
  const bold = button(page, 'Bold')
  await bold.hover()
  const tip = page.getByRole('tooltip')
  await expect(tip).toBeVisible()
  await expect(tip).toHaveAttribute('data-side', 'above')
  const [b, t] = await Promise.all([bold.boundingBox(), tip.boundingBox()])
  if (!b || !t) throw new Error('missing boxes')
  expect(t.y + t.height).toBeLessThanOrEqual(b.y - 11)

  // VoiceOver focuses a button before it presses it.
  await button(page, 'Bold').focus()
  await expect(toolbar(page)).toBeVisible()
  await page.keyboard.press('Space')
  await expect(page.locator('.cm-content')).toBeFocused()
  expect((await lines(page))[11]).toContain('**note**')
})
