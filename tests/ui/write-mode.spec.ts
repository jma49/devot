import type { Page } from '@playwright/test'
import { expect, test, openApp } from './fixtures'
import { expectSource, inEditMode } from './writeSource'

// Write mode (src/renderer/src/editor/write): an element without the caret shows no Markdown marks,
// the elements the selection meets show their source. The note's text is read through Edit mode, which shows
// every mark, switched to by a command so the keyboard stays in the editor.

const KA = String.fromCodePoint(0x304b)
const KAN = String.fromCodePoint(0x6f22)
const JI = String.fromCodePoint(0x5b57)

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const lines = (page: Page) => page.locator('.cm-line').allTextContents()
const modes = (page: Page) => page.getByRole('group', { name: 'View mode' })
const writeButton = (page: Page) =>
  page.locator('.editor-toolbar').getByRole('button', { name: 'Write Mode', exact: true })
const findBar = (page: Page) => page.getByRole('search', { name: 'Find in Note' })

const runCommand = (page: Page, id: string) =>
  page.evaluate(
    (detail) => {
      const w = window
      w.dispatchEvent(new w.CustomEvent('devot:open-url', { detail }))
    },
    { kind: 'command', id },
  )

async function createNote(page: Page, title: string, text = '') {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  if (!text) return
  await body(page).click()
  // Inserted at once, so the editor's bracket helpers do not interfere.
  await page.keyboard.insertText(text)
}

/** The box of character `index` of the first `text` in line `line` (0-based), as the page draws it. */
function charBox(page: Page, lineIndex: number, chars: string, nth = 0) {
  return body(page).evaluate(
    (content, asked) => {
      const { line, text, index } = asked
      const w = window
      const row = content.querySelectorAll('.cm-line')[line]
      if (!row) throw new Error('E_TEST_NO_LINE')
      const texts: Text[] = []
      const walk = (n: Node) => {
        if (n.nodeType === 3) texts.push(n as Text)
        else for (const c of n.childNodes) walk(c)
      }
      walk(row)
      const whole = texts.map((n) => n.data).join('')
      let at = whole.indexOf(text) + index
      if (whole.indexOf(text) < 0) throw new Error('E_TEST_NO_TEXT')
      for (const n of texts) {
        if (at < n.data.length) {
          const range = w.document.createRange()
          range.setStart(n, at)
          range.setEnd(n, at + 1)
          const r = range.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        }
        at -= n.data.length
      }
      throw new Error('E_TEST_NO_CHAR')
    },
    { line: lineIndex, text: chars, index: nth },
  )
}

/**
 * Types `steps` as an input method does at `column` of line `line` (0-based), whose text is its
 * source (the caret's line): each step replaces the text composed so far in the DOM, between
 * `compositionstart` and `compositionend`, a frame apart, and the editor reads the DOM.
 */
function compose(page: Page, lineIndex: number, col: number, parts: string[]) {
  return body(page).evaluate(
    async (content, asked) => {
      const { line, column, steps } = asked
      const w = window
      const el = content
      const frame = () => new Promise<void>((resolve) => w.requestAnimationFrame(() => resolve()))
      const place = () => {
        const row = el.querySelectorAll('.cm-line')[line]
        if (!row) throw new Error('E_TEST_NO_LINE')
        const texts: Text[] = []
        const walk = (n: Node) => {
          if (n.nodeType === 3) texts.push(n as Text)
          else for (const c of n.childNodes) walk(c)
        }
        walk(row)
        let at = column
        for (const n of texts) {
          if (at <= n.data.length) return { node: n, offset: at }
          at -= n.data.length
        }
        throw new Error('E_TEST_NO_COLUMN')
      }
      const init = { bubbles: true, composed: true }
      el.dispatchEvent(new w.CompositionEvent('compositionstart', { ...init, data: '' }))
      let typed = ''
      for (const step of steps) {
        const { node, offset } = place()
        node.data = node.data.slice(0, offset) + step + node.data.slice(offset + typed.length)
        typed = step
        try {
          w.document.getSelection()?.collapse(node, offset + step.length)
        } catch {
          // The editor reads the change from the text alone.
        }
        el.dispatchEvent(new w.CompositionEvent('compositionupdate', { ...init, data: step }))
        el.dispatchEvent(
          new w.InputEvent('input', {
            ...init,
            data: step,
            inputType: 'insertCompositionText',
            isComposing: true,
          }),
        )
        await frame()
      }
      el.dispatchEvent(new w.CompositionEvent('compositionend', { ...init, data: typed }))
      await frame()
      await frame()
    },
    { line: lineIndex, column: col, steps: parts },
  )
}

test.describe('a new install', () => {
  test.use({ install: 'new' })

  test.beforeEach(async ({ page }) => {
    await openApp(page)
  })

  test('opens notes in Write mode, its own button before the view modes', async ({ page }) => {
    await createNote(page, 'First')
    await expect(writeButton(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(modes(page).getByRole('button', { pressed: true })).toHaveCount(0)
    const names = await modes(page)
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((b) => b.ariaLabel))
    expect(names).toEqual(['Edit', 'Split', 'Preview'])
    const button = await writeButton(page).boundingBox()
    const group = await modes(page).boundingBox()
    if (!button || !group) throw new Error('E_TEST_NO_BOX')
    expect(group.x - (button.x + button.width)).toBeCloseTo(8, 0)
  })

  test('Write and the view modes are one choice: picking one leaves the other', async ({
    page,
  }) => {
    await createNote(page, 'One', '**bold**\nend')
    const toolbarBoxes = () =>
      page
        .locator('.editor-toolbar')
        .getByRole('button')
        .evaluateAll((buttons) =>
          buttons.map((b) => {
            const r = b.getBoundingClientRect()
            return [r.x, r.width]
          }),
        )
    const before = await toolbarBoxes()
    await modes(page).getByRole('button', { name: 'Split' }).click()
    await expect(writeButton(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('article', { name: 'Preview' })).toBeVisible()
    await expect.poll(() => lines(page)).toEqual(['**bold**', 'end'])
    await writeButton(page).click()
    await expect(writeButton(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(modes(page).getByRole('button', { pressed: true })).toHaveCount(0)
    // No segment is chosen, so the thumb neither slides nor stays behind.
    await expect(page.locator('.segment-thumb')).toHaveCount(0)
    await expect(page.getByRole('article', { name: 'Preview' })).toBeHidden()
    await expect.poll(() => lines(page)).toEqual(['bold', 'end'])
    await modes(page).getByRole('button', { name: 'Preview' }).click()
    await expect(writeButton(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(modes(page).getByRole('button', { pressed: true })).toHaveAccessibleName('Preview')
    await expect(page.locator('.segment-thumb')).toHaveCount(0)
    expect(await toolbarBoxes()).toEqual(before)
  })

  test('the Write Mode command switches to Write from Preview', async ({ page }) => {
    await createNote(page, 'Command', '**bold**\nend')
    await runCommand(page, 'view.preview')
    await expect(modes(page).getByRole('button', { pressed: true })).toHaveAccessibleName('Preview')
    await runCommand(page, 'view.write')
    await expect(writeButton(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(modes(page).getByRole('button', { pressed: true })).toHaveCount(0)
    await expect.poll(() => lines(page)).toContainEqual('bold')
  })

  test('shows a typed note as a document, with the source of the element at the caret', async ({
    page,
  }) => {
    const text = [
      '# Plan',
      'Some **bold**, *slanted* and `code` with [a link](https://example.com).',
      '> quoted',
      '',
      '- item',
    ]
    const styled = 'Some bold, slanted and code with a link.'
    await createNote(page, 'Typed', text.join('\n'))
    // A list mark stays a bullet on the caret line.
    await expect.poll(() => lines(page)).toEqual(['Plan', styled, 'quoted', '', '- item'])
    await expect(page.locator('.cm-wm-bullet')).toHaveCount(1)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => lines(page)).toEqual(['Plan', styled, 'quoted', '', '- item'])
    const slanted = await charBox(page, 1, 'slanted', 2)
    await page.mouse.click(slanted.x + 1, slanted.y + slanted.height / 2)
    await expect
      .poll(() => lines(page))
      .toEqual(['Plan', 'Some bold, *slanted* and code with a link.', 'quoted', '', '- item'])
    const link = await charBox(page, 1, 'link', 1)
    await page.mouse.click(link.x + 1, link.y + link.height / 2)
    await expect
      .poll(() => lines(page))
      .toEqual([
        'Plan',
        'Some bold, slanted and code with [a link](https://example.com).',
        'quoted',
        '',
        '- item',
      ])
    await page.keyboard.press('ControlOrMeta+Home')
    await expect.poll(() => lines(page)).toEqual(['# Plan', styled, 'quoted', '', '- item'])
    await page.keyboard.press('End')
    await page.keyboard.insertText(' **more**')
    await page.keyboard.press('ControlOrMeta+End')
    await expect.poll(() => lines(page)).toContainEqual('Plan more')
    await expectSource(page, ['# Plan **more**', ...text.slice(1)])
  })

  test('draws a highlight, a footnote and inline code without their marks, and [[text]] as plain text', async ({
    page,
  }) => {
    const text = ['Some ==marked== text, a note[^1], [[Plan]] and `code`.', '', '[^1]: The source.']
    await createNote(page, 'Inline', text.join('\n'))
    const rendered = 'Some marked text, a note1, [[Plan]] and code.'
    await expect.poll(() => lines(page)).toEqual([rendered, '', text[2]])
    await expect(page.locator('.cm-md-mark')).toHaveCSS(
      'background-color',
      'rgba(231, 176, 8, 0.3)',
    )
    await expect(page.locator('.cm-md-mark')).toHaveCSS('border-bottom-width', '2px')
    const footnote = page.locator('.cm-wm-footnote')
    await expect(footnote).toHaveCSS('font-size', '11px')
    await expect(footnote).toHaveCSS('position', 'relative')
    // The card's ink wash (WebKit keeps alpha in 1/255 steps).
    await expect(page.locator('.cm-md-code')).toHaveCSS(
      'background-color',
      /^rgba\(28, 27, 25, 0\.06\d*\)$/,
    )
    const height = () =>
      page
        .locator('.cm-line')
        .first()
        .evaluate((row) => row.getBoundingClientRect().height)
    const drawn = await height()
    await page.keyboard.press('ControlOrMeta+Home')
    await expect.poll(() => lines(page)).toEqual([rendered, '', '1The source.'])
    const mark = await charBox(page, 0, 'marked', 2)
    await page.mouse.click(mark.x + 1, mark.y + mark.height / 2)
    await expect
      .poll(() => lines(page))
      .toEqual(['Some ==marked== text, a note1, [[Plan]] and code.', '', '1The source.'])
    const note = await charBox(page, 0, 'note', 3)
    await page.mouse.click(note.x + note.width, note.y + note.height / 2)
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(() => lines(page))
      .toEqual(['Some marked text, a note[^1], [[Plan]] and code.', '', '1The source.'])
    expect(await height()).toBe(drawn)
    // As the preview shows it: no link line on the text or anything inside it.
    const lined = await page
      .locator('.cm-wm-plain, .cm-wm-plain *')
      .evaluateAll(
        (els) => els.filter((el) => getComputedStyle(el).textDecorationLine !== 'none').length,
      )
    expect(lined).toBe(0)
    await expect(page.locator('.cm-wm-plain').first()).toBeAttached()
    await expectSource(page, text)
  })

  test('draws an emoji, a key and raised and lowered text as the preview does, one source under the caret', async ({
    page,
  }) => {
    const text = ['Party :tada: then <kbd>Cmd</kbd> N, x<sup>2</sup> and H<sub>2</sub>O', '', 'End']
    await createNote(page, 'Inline HTML', text.join('\n'))
    const tada = String.fromCodePoint(0x1f389)
    await expect
      .poll(() => lines(page))
      .toEqual([`Party ${tada} then Cmd N, x2 and H2O`, '', 'End'])
    const key = page.locator('.cm-wm-inline kbd')
    await expect(key).toHaveText('Cmd')
    await expect(key).toHaveCSS('border-bottom-width', '2px')
    await expect(page.locator('.cm-wm-inline sup')).toHaveCSS('position', 'relative')
    await expect(page.locator('.cm-wm-inline sub')).toHaveText('2')
    const heights = () =>
      page
        .locator('.cm-line')
        .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))
    const [drawn, , plain] = await heights()
    expect(drawn).toBe(plain)
    await page.locator('.cm-wm-inline').first().click()
    await expect.poll(() => lines(page)).toEqual(['Party :tada: then Cmd N, x2 and H2O', '', 'End'])
    expect((await heights())[0]).toBe(drawn)
    await expectSource(page, text)
  })

  test('shows a horizontal rule as source only while the caret is on it', async ({ page }) => {
    await createNote(page, 'Rule', 'a\n\n---\n\nb')
    await expect.poll(() => lines(page)).toEqual(['a', '', '', '', 'b'])
    await expect(page.locator('.cm-line.cm-wm-rule')).toHaveCount(1)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => lines(page)).toEqual(['a', '', '---', '', 'b'])
    await expect(page.locator('.cm-line.cm-wm-rule')).toHaveCount(0)
  })

  test('keeps the other lines in place when a line shows its marks', async ({ page }) => {
    await createNote(page, 'Still', '# Head\n\n**bold** line\n\n> quote\n\nlast')
    await body(page).click()
    const tops = () =>
      page
        .locator('.cm-line')
        .evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().y)))
    await page.keyboard.press('ControlOrMeta+End')
    const before = await tops()
    for (const line of [0, 2, 4]) {
      const box = await charBox(page, line, line === 0 ? 'Head' : line === 2 ? 'bold' : 'quote', 1)
      await page.mouse.click(box.x + 1, box.y + box.height / 2)
      await expect.poll(() => tops()).toEqual(before)
    }
  })

  test('puts the caret where the pointer is on a line without its marks', async ({ page }) => {
    await createNote(page, 'Pointer', '**bold** and more\nother')
    await body(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    await expect.poll(() => lines(page)).toEqual(['bold and more', 'other'])
    const o = await charBox(page, 0, 'bold', 1)
    await page.mouse.click(o.x + 1, o.y + o.height / 2)
    await page.keyboard.insertText('Z')
    await expectSource(page, ['**bZold** and more', 'other'])
  })

  test('double-clicks the word under the pointer, not the one the marks moved there', async ({
    page,
  }) => {
    await createNote(page, 'Words', '**Some text** here\nother')
    await body(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    const word = await charBox(page, 0, 'text', 1)
    await page.mouse.dblclick(word.x + 1, word.y + word.height / 2)
    await page.keyboard.insertText('X')
    await expectSource(page, ['**Some X** here', 'other'])
  })

  test('moves the caret by visible character into a line without its marks', async ({ page }) => {
    await createNote(page, 'Keys', '**aa**aa\naaaa')
    await body(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.insertText('Q')
    await expectSource(page, ['**aQa**aa', 'aaaa'])
  })

  test('types at every caret of several and undoes as one step', async ({ page }) => {
    await createNote(page, 'Cursors', '**cat** one\n# cat two\n- cat three')
    await body(page).click()
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('ControlOrMeta+Alt+KeyG')
    await page.keyboard.press('ControlOrMeta+Alt+KeyG')
    await page.keyboard.insertText('dog')
    await expect.poll(() => lines(page)).toEqual(['**dog** one', '# dog two', '- dog three'])
    await page.keyboard.press('ControlOrMeta+KeyZ')
    await expectSource(page, ['**cat** one', '# cat two', '- cat three'])
  })

  test('finds and replaces text on lines without their marks', async ({ page }) => {
    await createNote(page, 'Find', 'a **cat** here\nno\n# cat')
    await body(page).click()
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.press('Alt+Meta+f')
    const field = findBar(page).getByRole('textbox', { name: 'Find' })
    await expect(field).toBeFocused()
    await page.keyboard.type('cat')
    await expect(findBar(page).getByRole('status')).toHaveText('1 of 2')
    await findBar(page).getByRole('textbox', { name: 'Replace' }).fill('dog')
    await findBar(page).getByRole('textbox', { name: 'Replace' }).press('Enter')
    await findBar(page).getByRole('textbox', { name: 'Replace' }).press('Enter')
    await findBar(page).getByRole('textbox', { name: 'Replace' }).press('Escape')
    await body(page).click()
    await expectSource(page, ['a **dog** here', 'no', '# dog'])
  })

  test('ticks a task from its checkbox without moving the caret', async ({ page }) => {
    await createNote(page, 'Tasks', '- [ ] write\n- [x] read\nend')
    await body(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    const boxes = page.getByRole('checkbox', { name: 'Toggle Task' })
    await expect(boxes).toHaveCount(2)
    await expect(boxes.nth(1)).toBeChecked()
    await boxes.first().click()
    await expect(boxes.first()).toBeChecked()
    await expect.poll(() => lines(page)).toEqual(['write', 'read', 'end'])
    await page.keyboard.insertText('!')
    // The caret's line keeps its checkbox.
    await page.keyboard.press('ArrowUp')
    await expect(boxes).toHaveCount(2)
    await expect.poll(() => lines(page)).toEqual(['write', 'read', 'end!'])
    await expectSource(page, ['- [x] write', '- [x] read', 'end!'])
  })

  test('draws a done and an open task box alike, on the list mark column and the text centre', async ({
    page,
  }) => {
    await createNote(page, 'Aligned', '- item\n- [x] done\n- [ ] open\nend')
    await body(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    await expect(page.locator('.cm-wm-task-box')).toHaveCount(2)
    await expect(page.locator('.cm-md-task-done')).toHaveText('done')

    const measure = async () => {
      const [done, open] = await page.locator('.cm-wm-task-box').evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        }),
      )
      const bullet = await page.locator('.cm-wm-bullet').boundingBox()
      return {
        boxes: [done, open],
        bullet,
        texts: [await charBox(page, 1, 'done'), await charBox(page, 2, 'open')],
      }
    }

    const away = await measure()
    const [done, open] = away.boxes
    if (!done || !open || !away.bullet) throw new Error('E_TEST_NO_BOX')
    const fontSize = await page
      .locator('.cm-wm-task')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    expect(Math.abs(done.width - 0.875 * fontSize)).toBeLessThanOrEqual(0.5)
    expect(open.width).toBeCloseTo(done.width, 1)
    expect(open.height).toBeCloseTo(done.height, 1)
    expect(Math.abs(open.x - done.x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(done.x - away.bullet.x)).toBeLessThanOrEqual(1)
    for (const [i, box] of [done, open].entries()) {
      const text = away.texts[i]
      if (!text) throw new Error('E_TEST_NO_TEXT')
      expect(Math.abs(box.y + box.height / 2 - (text.y + text.height / 2))).toBeLessThanOrEqual(1)
      expect(text.x).toBeGreaterThan(box.x + box.width)
    }
    expect(Math.abs((away.texts[0]?.x ?? 0) - (away.texts[1]?.x ?? 0))).toBeLessThanOrEqual(0.5)

    // A task's box is never source, so the caret on its line moves nothing.
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('End')
    expect(await measure()).toEqual(away)
  })

  test('folds front matter to one row that opens on click', async ({ page }) => {
    await createNote(page, 'Matter', '---\ntitle: x\ntags: a\n---\nBody')
    await body(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    const row = page.locator('.cm-wm-front-matter')
    await expect(row).toHaveText(/Front matter\s*title, tags/)
    await expect.poll(() => lines(page)).toEqual(['Body'])
    await row.click()
    await expect(row).toHaveCount(0)
    await expect.poll(() => lines(page)).toEqual(['---', 'title: x', 'tags: a', '---', 'Body'])
  })

  test.describe('with an input method', () => {
    test('composing inside bold text keeps every character in order', async ({ page }) => {
      await createNote(page, 'Bold')
      await body(page).click()
      await page.keyboard.insertText('**bold**\nnext')
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('End')
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft')
      await compose(page, 0, 4, ['k', KA, KAN])
      await compose(page, 0, 5, [JI])
      await expect.poll(() => lines(page)).toEqual([`**bo${KAN}${JI}ld**`, 'next'])
      await expectSource(page, [`**bo${KAN}${JI}ld**`, 'next'])
    })

    test('composing at the start of a heading keeps every character in order', async ({ page }) => {
      await createNote(page, 'Head')
      await body(page).click()
      await page.keyboard.insertText('# ')
      await compose(page, 0, 2, ['k', KA, KAN])
      await compose(page, 0, 3, [JI])
      await page.keyboard.press('Enter')
      await expect.poll(() => lines(page)).toEqual([`${KAN}${JI}`, ''])
      await expectSource(page, [`# ${KAN}${JI}`, ''])
    })

    test('composing after a list marker keeps every character in order', async ({ page }) => {
      await createNote(page, 'List')
      await body(page).click()
      await page.keyboard.insertText('- ')
      await compose(page, 0, 2, ['k', KA, KAN])
      await compose(page, 0, 3, [JI])
      await expect.poll(() => lines(page)).toEqual([`- ${KAN}${JI}`])
      await expectSource(page, [`- ${KAN}${JI}`])
    })
  })
})

test.describe('switching between Write and Edit', () => {
  test.use({ install: 'new' })

  test.beforeEach(async ({ page }) => {
    await openApp(page)
  })

  test('keeps the caret and the line at the top', async ({ page }) => {
    const text = Array.from({ length: 200 }, (_, i) =>
      i % 5 === 0 ? `## Part ${i}` : `Line **${i}**`,
    )
    await createNote(page, 'Long', text.join('\n'))
    await body(page).click()
    await page.keyboard.press('ControlOrMeta+Home')
    for (let i = 0; i < 101; i++) await page.keyboard.press('ArrowDown')
    await page.keyboard.press('End')
    const scroller = page.locator('.editor-scroll')
    const topLine = () =>
      body(page).evaluate((content) => {
        const el = content
        const top = el.closest('.editor-scroll')?.getBoundingClientRect().top ?? 0
        const rows = [...el.querySelectorAll('.cm-line')]
        return rows.find((r) => r.getBoundingClientRect().bottom > top + 1)?.textContent ?? ''
      })
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    const before = await topLine()
    await modes(page).getByRole('button', { name: 'Edit' }).click()
    await expect(modes(page).getByRole('button', { pressed: true })).toHaveAccessibleName('Edit')
    await expect
      .poll(async () => (await topLine()).replace(/^## |\*\*/g, ''))
      .toBe(before.replace(/^## |\*\*/g, ''))
    await writeButton(page).click()
    await expect(writeButton(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(modes(page).getByRole('button', { pressed: true })).toHaveCount(0)
    await expect.poll(topLine).toBe(before)
    await body(page).focus()
    await page.keyboard.insertText('!')
    // Only the lines near the view are drawn.
    await inEditMode(page, (read) => expect.poll(read).toContainEqual(`${text[101]}!`))
  })

  test('comes back to Write from Preview', async ({ page }) => {
    await createNote(page, 'Back', '**bold**\nend')
    await body(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('Meta+KeyE')
    await expect(modes(page).getByRole('button', { pressed: true })).toHaveAccessibleName('Preview')
    await page.keyboard.press('Meta+KeyE')
    await expect(writeButton(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(modes(page).getByRole('button', { pressed: true })).toHaveCount(0)
    await expect.poll(() => lines(page)).toContainEqual('bold')
  })
})

test.describe('an install from before Write mode', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
  })

  test('keeps opening notes in Edit mode', async ({ page }) => {
    await createNote(page, 'Kept', '**bold**\nend')
    await expect(modes(page).getByRole('button', { pressed: true })).toHaveAccessibleName('Edit')
    await expect.poll(() => lines(page)).toEqual(['**bold**', 'end'])
  })
})
