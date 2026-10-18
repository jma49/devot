import type { Locator, Page } from '@playwright/test'
import {
  changeEditorSettingsElsewhere,
  expect,
  pickMenuItem,
  shownMenu,
  test,
  type TestWindow,
  pickNoteMore,
} from '../ui/fixtures'
import {
  composite,
  contrastRatio,
  parseColor,
  type Rgb,
} from '../../src/renderer/src/theme/contrast'

// The built UI under the production CSP (scripts/serve-csp.ts). `pnpm dev`
// relaxes the policy, so only these tests see what the app sees.

declare global {
  // Only the members these tests read; this config has no DOM types.
  var devotCspViolations: string[]
}

async function start(page: Page, path = '/') {
  await page.addInitScript(() => {
    type Violation = {
      violatedDirective: string
      blockedURI: string
      target: { nodeName?: string } | null
    }
    const win = globalThis as unknown as {
      addEventListener(type: string, listener: (event: Violation) => void): void
    }
    globalThis.devotCspViolations = []
    win.addEventListener('securitypolicyviolation', (event) => {
      // WebKit styles a <select>'s internal parts through a style attribute
      // and reports it against the page's policy; the control still renders
      // and works. Every other violation counts.
      if (event.violatedDirective === 'style-src-attr' && event.target?.nodeName === 'SELECT')
        return
      globalThis.devotCspViolations.push(`${event.violatedDirective} ${event.blockedURI}`)
    })
  })
  await page.route(/^https:\/\//, (route) => route.abort())
  await page.goto(path)
}

async function newNote(page: Page, body: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(body)
  await page.getByRole('button', { name: 'Split' }).click()
}

const violations = (page: Page) => page.evaluate(() => globalThis.devotCspViolations)

test('the editor is styled and nothing breaks the policy', async ({ page }) => {
  await start(page)
  await newNote(page, '# Heading\n\nText with $x^2$, :tada: and `#ff0000`.')
  // CodeMirror's injected styles apply (line numbers are off by default).
  await expect(page.locator('.cm-editor')).toHaveCSS('display', 'flex')
  await expect(page.getByRole('article', { name: 'Preview' }).locator('math')).toHaveCount(1)
  await expect(page.locator('.swatch')).toHaveCSS('background-color', 'rgb(255, 0, 0)')
  expect(await violations(page)).toEqual([])
})

test('mermaid diagrams render with their theme', async ({ page }) => {
  await start(page)
  await newNote(page, '```mermaid\ngraph LR\n  Draft --> Done\n```')
  const rect = page.locator('.island-mermaid svg .node rect').first()
  await expect(rect).toBeVisible()
  await expect
    .poll(() =>
      rect.evaluate(
        (el) =>
          (
            globalThis as unknown as { getComputedStyle(e: unknown): { fill: string } }
          ).getComputedStyle(el).fill,
      ),
    )
    .not.toBe('rgb(0, 0, 0)')
})

test('the [[ link popup is styled and positioned under the policy', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Target')
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.type('[[')
  const popup = page.locator('.cm-tooltip-autocomplete')
  await expect(popup.getByRole('option', { name: 'Target' })).toBeVisible()
  // Its theme applies, and its position (set through CSSOM) puts it just
  // below the line being typed, inside the window.
  await expect(popup.getByRole('option').first()).not.toHaveCSS('border-radius', '0px')
  const line = await page.locator('.cm-line').filter({ hasText: '[[' }).first().boundingBox()
  const box = await popup.boundingBox()
  const viewport = page.viewportSize()
  expect(line && box && viewport).toBeTruthy()
  if (line && box && viewport) {
    expect(box.y).toBeGreaterThanOrEqual(line.y + line.height - 3)
    expect(box.y - (line.y + line.height)).toBeLessThan(20)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  }
  expect(await violations(page)).toEqual([])
})

test('the note menu and the notebook picker work under the policy', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Filed')
  const row = page.getByRole('listbox', { name: 'Notes' }).getByRole('option', { name: /Filed/ })
  await row.click({ button: 'right' })
  // The menu code is its own chunk, loaded on the first right-click.
  await expect.poll(() => shownMenu(page)).toContain('Move to Notebook\u2026 M')
  await pickMenuItem(page, 'Move to Notebook\u2026')
  const picker = page.getByRole('dialog', { name: 'Move to Notebook' })
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('option', { name: 'No Notebook' })).not.toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  expect(await violations(page)).toEqual([])
})

test('a note exports as an HTML page with its diagram drawn, under the policy', async ({
  page,
}) => {
  await start(page)
  await page.evaluate(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      export_begin: { id: 1, fileName: 'Chart.html' },
      export_write: null,
      export_finish: null,
    }
  })
  await newNote(page, '# Chart\n\n```mermaid\ngraph LR\n  Draft --> Done\n```')
  const row = page.getByRole('listbox', { name: 'Notes' }).getByRole('option').first()
  await row.click({ button: 'right' })
  // The export code is its own chunk, loaded on first use.
  await expect.poll(() => shownMenu(page)).toContain('Export as HTML\u2026')
  await pickMenuItem(page, 'Export as HTML\u2026')
  const written = () =>
    page.evaluate(() =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((c) => c.cmd === 'export_write')
        .map((c) => String(c.args['text'])),
    )
  await expect.poll(written, { timeout: 20_000 }).toHaveLength(1)
  const [html] = await written()
  expect(html).toMatch(/<div class="island island-mermaid"><svg[^>]*>.*<style>/s)
  expect(html).toContain('<h1>Chart</h1>')
  expect(await violations(page)).toEqual([])
})

test('a Markdown folder import runs in the built worker under the policy', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as { devotIpcMocks: Record<string, unknown> }
    w.devotIpcMocks = {
      import_read: () => '---\ntags: [csp]\n---\n# Imported\n\n![Pic](pic.png)\n',
      import_attach: null,
      import_finish: null,
    }
  })
  await start(page)
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string, init: { detail: unknown }) => unknown
    }
    const scan = {
      id: 1,
      name: 'Folder',
      kind: 'folder',
      files: [{ path: 'Note.md', bytes: 50 }],
      images: [],
      skipped: [],
    }
    w.dispatchEvent(new w.CustomEvent('devot:import-ready', { detail: scan }))
  })
  const dialog = page.getByRole('dialog', { name: 'Import Markdown Folder' })
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(dialog).toContainText('Imported 1 note.')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('listbox', { name: 'Notes' }).getByRole('option').first().click()
  await expect(page.getByRole('textbox', { name: 'Note body' })).toContainText(
    '![Pic](devot://file/',
  )
  expect(await violations(page)).toEqual([])
})

test('the notebook menu works and outlines its notebook under the policy', async ({ page }) => {
  await start(page)
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await page.getByRole('button', { name: 'New Notebook' }).click()
  await field.fill('Outer')
  await field.press('Enter')
  const row = page.getByRole('treeitem', { name: /^Outer\b/ }).locator('> .book-row')
  // Hold the menu open, to see the outline.
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow & { closeMenu?: () => void }
    w.devotIpcMocks = {
      'plugin:menu|popup': () =>
        new Promise<null>((resolve) => {
          w.closeMenu = () => resolve(null)
        }),
    }
  })
  await row.click({ button: 'right' })
  // The menu code is its own chunk, loaded on the first right-click.
  await expect.poll(() => shownMenu(page)).toContain('New Notebook Inside')
  // (a selected row under the keyboard also has a 5 px bar in its box-shadow)
  await expect(row).toHaveCSS('box-shadow', /0px 0px 0px 2px inset$/)
  await page.evaluate(() => (globalThis as unknown as { closeMenu: () => void }).closeMenu())
  await expect(row).not.toHaveCSS('box-shadow', /0px 0px 0px 2px inset$/)
  await pickMenuItem(page, 'New Notebook Inside')
  await field.fill('Inner')
  await field.press('Enter')
  const inner = page.getByRole('treeitem', { name: /^Inner\b/ })
  await expect(inner).toHaveAttribute('aria-level', '2')
  await page.evaluate(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {}
  })
  await inner.locator('> .book-row').click({ button: 'right' })
  await expect.poll(() => shownMenu(page)).toContain('Move to Top Level')
  await pickMenuItem(page, 'Move to Top Level')
  await expect(inner).toHaveAttribute('aria-level', '1')
  expect(await violations(page)).toEqual([])
})

test('notebook drops show their insertion line and indent under the policy', async ({ page }) => {
  await start(page)
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    await page.getByRole('button', { name: 'New Notebook' }).click()
    await field.fill(name)
    await field.press('Enter')
  }
  const row = (name: string) =>
    page.getByRole('treeitem', { name: new RegExp(`^${name}\\b`) }).locator('> .book-row')
  const box = async (name: string) => {
    const b = await row(name).boundingBox()
    if (!b) throw new Error('E_TEST_NO_BOX')
    return b
  }
  // The middle nests: the indent comes from a custom property set through the CSSOM.
  const alpha = await box('Alpha')
  await row('Charlie').dragTo(row('Alpha'), {
    targetPosition: { x: alpha.width / 2, y: alpha.height / 2 },
  })
  await expect(page.getByRole('treeitem', { name: /^Charlie\b/ })).toHaveAttribute(
    'aria-level',
    '2',
  )
  const indent = (name: string) =>
    row(name).evaluate(
      (el) =>
        (
          globalThis as unknown as { getComputedStyle(e: unknown): { paddingInlineStart: string } }
        ).getComputedStyle(el).paddingInlineStart,
    )
  expect(await indent('Alpha')).toBe('6px')
  expect(await indent('Charlie')).toBe('24px')

  // Dragging over the top edge of Alpha draws a line there.
  const from = await box('Bravo')
  const to = await box('Alpha')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  // After the open Alpha: the line is on its item, under Charlie, across Alpha's width.
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 2, { steps: 4 })
  // (beside Alpha's own treeitem, in the item that holds its sub-notebooks)
  const alphaItem = page.getByRole('treeitem', { name: /^Alpha\b/ }).locator('+ li')
  await expect(alphaItem).toHaveClass(/drop-after/)
  const after = await alphaItem.evaluate((el) => {
    const style = (
      globalThis as unknown as {
        getComputedStyle(e: unknown, p: string): { height: string; left: string }
      }
    ).getComputedStyle(el, '::after')
    return { height: style.height, left: style.left }
  })
  expect(after).toEqual({ height: '2px', left: '0px' })
  await page.mouse.move(to.x + to.width / 2, to.y + 2, { steps: 4 })
  await expect(row('Alpha')).toHaveClass(/drop-before/)
  const line = await row('Alpha').evaluate((el) => {
    const style = (
      globalThis as unknown as {
        getComputedStyle(
          e: unknown,
          p: string,
        ): { height: string; backgroundColor: string; position: string }
      }
    ).getComputedStyle(el, '::before')
    return { height: style.height, background: style.backgroundColor, position: style.position }
  })
  expect(line).toMatchObject({ height: '2px', position: 'absolute' })
  expect(line.background).not.toBe('rgba(0, 0, 0, 0)')
  await page.mouse.up()
  await expect(page.getByRole('treeitem').first()).toHaveAccessibleName(/^Bravo\b/)
  expect(await violations(page)).toEqual([])
})

test('the selection toolbar is styled and placed by the editor under the policy', async ({
  page,
}) => {
  await start(page)
  await newNote(page, 'one\ntwo\nthree\nfour\nfifth line')
  await page.getByRole('button', { name: 'Edit' }).click()
  const body = page.getByRole('textbox', { name: 'Note body' })
  await body.click()
  // Double-click the last word: a mouse word selection works the same on
  // every platform (the keys that move by word differ).
  const at = await page
    .locator('.cm-line')
    .last()
    .evaluate((line) => {
      type Box = { x: number; y: number; width: number; height: number }
      const doc = (
        globalThis as unknown as {
          document: {
            createTreeWalker(root: unknown, show: number): { nextNode(): { data: string } | null }
            createRange(): {
              setStart(node: unknown, offset: number): void
              setEnd(node: unknown, offset: number): void
              getBoundingClientRect(): Box
            }
          }
        }
      ).document
      const texts = doc.createTreeWalker(line, 4 /* NodeFilter.SHOW_TEXT */)
      for (let node = texts.nextNode(); node; node = texts.nextNode()) {
        const i = node.data.indexOf('line')
        if (i < 0) continue
        const range = doc.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + 4)
        const r = range.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }
      return null
    })
  if (!at) throw new Error('E_TEST_NO_WORD')
  await page.mouse.dblclick(at.x, at.y)
  const toolbar = page.getByRole('toolbar', { name: 'Format' })
  await expect(toolbar).toBeVisible()
  // Its theme (a constructed sheet) applies, the icons get their mask
  // through the CSSOM, and its position (set through the CSSOM too) puts it
  // just above the selected word.
  const bold = toolbar.getByRole('button', { name: 'Bold' })
  await expect(bold).toHaveCSS('width', '28px')
  await expect(bold).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(bold.locator('.icon')).not.toHaveCSS('mask-image', 'none')
  const word = await page.locator('.cm-selectionBackground').first().boundingBox()
  const box = await toolbar.boundingBox()
  expect(word && box).toBeTruthy()
  if (word && box) {
    expect(box.y + box.height).toBeLessThanOrEqual(word.y + 1)
    expect(word.y - (box.y + box.height)).toBeLessThan(20)
  }
  await bold.click()
  await expect(page.locator('.cm-line').last()).toHaveText('fifth **line**')
  expect(await violations(page)).toEqual([])
})

test('revision history compares and restores under the policy', async ({ page }) => {
  await start(page)
  const body = page.getByRole('textbox', { name: 'Note body' })
  const row = page.getByRole('listbox', { name: 'Notes' }).getByRole('option', { name: /Kept/ })
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Kept')
  await body.click()
  await page.keyboard.insertText('old line')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const store = globalThis as unknown as { localStorage: { getItem(k: string): string } }
        return store.localStorage.getItem('devot.test.notes')
      }),
    )
    .toContain('"bodyMd":"old line"')
  // A fresh session: the next edit keeps the saved text as a version.
  await page.reload()
  await row.click()
  await body.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\nnew line')
  await pickNoteMore(page, 'Revision History\u2026')
  const sheet = page.getByRole('dialog', { name: 'Revision History' })
  await sheet.getByRole('option').filter({ hasText: 'Earliest version' }).click()
  const added = sheet.locator('.diff-added')
  await expect(added).toHaveText('+new line')
  await expect(added).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await sheet.getByRole('button', { name: 'Restore' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(body).toHaveText('old line')
  expect(await violations(page)).toEqual([])
})

test('find marks matches in the editor and the preview under the policy', async ({ page }) => {
  await start(page)
  await newNote(page, 'alpha **beta** alpha')
  const bar = page.getByRole('search', { name: 'Find in Note' })
  // The editor (split mode, the editor focused): marks come from its
  // constructed sheet, with the token colours.
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.press('Meta+f')
  await page.keyboard.type('alpha')
  await expect(bar.getByRole('status')).toHaveText('1 of 2')
  await expect(bar).toHaveCSS('display', 'flex')
  const marks = page.locator('.cm-find-match')
  await expect(marks).toHaveCount(2)
  await expect(marks.first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('.cm-find-current')).not.toHaveCSS(
    'background-color',
    await marks
      .last()
      .evaluate(
        (el) =>
          (
            globalThis as unknown as { getComputedStyle(e: unknown): { backgroundColor: string } }
          ).getComputedStyle(el).backgroundColor,
      ),
  )
  // The preview: the rendered text, painted as highlights.
  await page.getByRole('article', { name: 'Preview' }).locator('strong').click()
  await page.keyboard.press('Meta+f')
  await page.keyboard.type('alpha beta')
  await expect(bar.getByRole('status')).toHaveText('1 of 1')
  expect(
    await page.evaluate(() => {
      const registry = (
        globalThis as unknown as { CSS: { highlights: Map<string, { size: number }> } }
      ).CSS.highlights
      return registry.get('devot-find-current')?.size
    }),
  ).toBe(1)
  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
  expect(await violations(page)).toEqual([])
})

/** A pane's tab in the settings window, which shows one pane at a time. */
const settingsTab = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'Settings panes' }).getByRole('tab', { name, exact: true })

test('the settings window lists usage events within the policy', async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      usage_list: [{ id: 1, at: 0, name: 'note.created', properties: { from: 'new_note' } }],
    }
  })
  await start(page, '/settings.html')
  await settingsTab(page, 'Usage').click()
  const section = page.getByRole('region', { name: 'Usage Data' })
  await expect(section.getByRole('table', { name: 'Events by type' })).toContainText('Note created')
  await section.getByRole('button', { name: 'Show Events' }).click()
  await expect(section.getByRole('list', { name: 'Stored events' })).toContainText('from: new_note')
  expect(await violations(page)).toEqual([])
})

test('the editor settings work under the policy in both windows', async ({ page }) => {
  await start(page, '/settings.html')
  await settingsTab(page, 'Editing').click()
  const editor = page.getByRole('region', { name: 'Editing' }).first()
  await editor.getByRole('switch', { name: 'Spellcheck' }).check()
  await editor.getByRole('combobox', { name: 'Font Family' }).selectOption('Menlo')
  await editor.getByRole('spinbutton', { name: 'Font Size' }).fill('18')
  await expect(editor.getByRole('combobox', { name: 'Line Height' })).toHaveValue('1.5')
  expect(await violations(page)).toEqual([])

  // The main window, with settings that set CSS variables and reconfigure the editor.
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotEditorRevision = 1
    w.devotEditorSettings = { fontSize: 18, fontFamily: 'menlo', readableWidth: true }
  })
  await start(page)
  await newNote(page, 'Some text')
  const content = page.locator('.cm-content')
  await expect(content).toHaveCSS('font-size', '18px')
  // Split mode gives each pane half the note area; Edit keeps the reading width.
  await expect(content).toHaveCSS('max-width', 'none')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(content).toHaveCSS('max-width', '740px')
  await page.keyboard.press('Meta+Equal')
  await expect(content).toHaveCSS('font-size', '19px')
  await changeEditorSettingsElsewhere(page, { lineNumbers: false, spellCheck: true, tabWidth: 8 })
  await expect(page.locator('.cm-gutters')).toHaveCount(0)
  await expect(content).toHaveAttribute('spellcheck', 'true')
  await expect(content).toHaveCSS('tab-size', '8')
  expect(await violations(page)).toEqual([])
})

test('the command palette is styled and runs commands under the policy', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Palette')
  await page.keyboard.press('Meta+KeyK')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  const field = palette.getByRole('combobox', { name: 'Command Palette' })
  await expect(field).toBeFocused()
  await field.fill('focus')
  const selected = palette.locator('[role="option"][aria-selected="true"]')
  await expect(selected).toContainText('Focus Mode')
  await expect(selected).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(selected.locator('mark').first()).toHaveCSS('font-weight', '600')
  await expect(palette).toHaveCSS('border-radius', '8px')
  await field.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Focus Mode' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(await violations(page)).toEqual([])
})

test('the activity heatmap is styled under the policy', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText('Written today')
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:show-activity'))
  })
  const sheet = page.getByRole('dialog', { name: 'Activity' })
  const today = sheet.getByRole('grid', { name: 'Activity by day' }).locator('[tabindex="0"]')
  await expect(today).toHaveClass(/\bactivity-level-4\b/)
  await expect(today).toHaveAccessibleName(
    /: 1 note created, 1 note edited, 13 characters changed$/,
  )
  // Shades come from the stylesheet, never from inline styles.
  await expect(today).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(sheet.locator('.activity-legend .activity-level-0')).not.toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await expect(sheet.locator('[style]')).toHaveCount(0)
  expect(await violations(page)).toEqual([])
})

test('code blocks get a styled copy button and split mode scrolls together under the policy', async ({
  page,
}) => {
  await start(page)
  const sections = Array.from({ length: 80 }, (_, i) => `## Part ${i + 1}\n\nText ${i + 1}.`)
  // A bare fence: its button sits in the block's corner (a header holds it otherwise).
  await newNote(page, '```\nconst x = 1\n```\n\n' + sections.join('\n\n'))
  const preview = page.getByRole('article', { name: 'Preview' })
  const copy = preview.getByRole('button', { name: 'Copy Code' })
  await preview.locator('pre').hover()
  await expect(copy).toHaveCSS('position', 'absolute')
  await expect(copy).toHaveCSS('opacity', '1')
  await copy.click()
  await expect(preview.getByRole('button', { name: 'Copied' })).toBeVisible()
  // The editor scrolls; the preview follows.
  await page
    .locator('[data-devot-part="editor-scroll"]')
    .evaluate((box) => (box.scrollTop = box.scrollHeight / 2))
  await expect.poll(() => preview.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
  expect(await violations(page)).toEqual([])
})

test('images under their lines and the image viewer are styled under the policy', async ({
  page,
}) => {
  await start(page)
  const file = 'devot://file/0192a6f0-0000-7000-8000-00000000f001'
  await newNote(page, `![Shot](${file}#half)\n\nafter`)
  await expect(page.locator('.cm-inline-images')).toHaveCSS('height', '160px')
  const img = page.getByRole('article', { name: 'Preview' }).locator('img')
  await expect(img).toHaveClass(/\bimage-size-half\b/)
  await img.dblclick()
  const viewer = page.getByRole('dialog', { name: 'Image Viewer: Shot' })
  await expect(viewer).toBeVisible()
  await expect(viewer).toHaveCSS('display', 'flex')
  await expect(viewer.getByRole('button', { name: 'Close' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
  expect(await violations(page)).toEqual([])
})

test('an image from the web loads in the preview and under its line, within the policy', async ({
  page,
}) => {
  await start(page)
  // A 1x1 PNG served for the web address; nothing leaves the machine.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  )
  await page.route('https://example.com/chart.png', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: png }),
  )
  const address = 'https://example.com/chart.png'
  await newNote(page, `![Chart](${address})\n\nafter`)
  const loaded = (img: Locator) =>
    img.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth)
  const shown = page.getByRole('article', { name: 'Preview' }).locator(`img[src="${address}"]`)
  await expect(shown).toBeVisible()
  await expect.poll(() => loaded(shown)).toBe(1)
  const under = page.locator('.cm-inline-images img')
  await expect(under).toHaveAttribute('src', address)
  await expect.poll(() => loaded(under)).toBe(1)
  await expect(page.getByText('Image from the web not loaded')).toHaveCount(0)
  expect(await violations(page)).toEqual([])
})

// The editor's colours come from the design tokens in both appearances: the
// syntax colours, the gutter, the active line and the selection stay readable.
interface Seen {
  color: string
  background: string
  decoration: string
  opacity: string
}
interface Probe {
  /** The nodes the walker reaches in the editor's shadow tree. */
  createTreeWalker(
    root: unknown,
    what: number,
  ): { nextNode(): { nodeValue: string | null; parentElement: unknown } | null }
}

/** The computed style of the element that holds `needle` as text in the editor. */
function textStyle(page: Page, needle: string): Promise<Seen> {
  return page.locator('.cm-content').evaluate((root, text) => {
    const g = globalThis as unknown as {
      document: Probe
      getComputedStyle(e: unknown): {
        color: string
        backgroundColor: string
        textDecorationLine: string
        opacity: string
      }
    }
    const walker = g.document.createTreeWalker(root, 4)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue?.includes(text)) continue
      const style = g.getComputedStyle(node.parentElement)
      return {
        color: style.color,
        background: style.backgroundColor,
        decoration: style.textDecorationLine,
        opacity: style.opacity,
      }
    }
    throw new Error('E_TEST_TEXT_NOT_FOUND')
  }, needle)
}

/** The style of the first element matching `selector` in the editor. */
function partStyle(page: Page, selector: string): Promise<Seen> {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const g = globalThis as unknown as {
        getComputedStyle(e: unknown): {
          color: string
          backgroundColor: string
          textDecorationLine: string
          opacity: string
        }
      }
      const style = g.getComputedStyle(el)
      return {
        color: style.color,
        background: style.backgroundColor,
        decoration: style.textDecorationLine,
        opacity: style.opacity,
      }
    })
}

/** A theme variable's value, as the editor sees it. */
async function themeColour(page: Page, name: string): Promise<string> {
  const value = await page.locator('.cm-content').evaluate(
    (el, variable) =>
      (
        globalThis as unknown as {
          getComputedStyle(e: unknown): { getPropertyValue(n: string): string }
        }
      )
        .getComputedStyle(el)
        .getPropertyValue(variable),
    name,
  )
  return value.trim()
}

const NOTE_FOR_COLOURS = [
  '# Heading',
  '',
  '| Head | Other |',
  '| :- | :- |',
  '| 1 | 2 |',
  '',
  '[site](https://example.com/page) and [note](devot://note/abc)',
  '',
  '---',
  '',
  `long ${'word '.repeat(80)}end`,
  '',
  'plain line',
].join('\n')

for (const scheme of ['light', 'dark'] as const) {
  test(`the editor is readable in ${scheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    // Unwrapped lines scroll sideways under the line numbers.
    await page.addInitScript(() => {
      const w = globalThis as unknown as TestWindow
      w.devotEditorRevision = 1
      w.devotEditorSettings = { lineNumbers: true, lineWrapping: false, highlightActiveLine: true }
    })
    await start(page)
    await newNote(page, NOTE_FOR_COLOURS)
    await page.getByRole('textbox', { name: 'Note body' }).click()
    await page.keyboard.press('ControlOrMeta+End')

    const surface = parseColor(await themeColour(page, '--color-surface-editor')).rgb
    const rgb = (css: string): Rgb => composite(parseColor(css), surface)
    const ratio = (fg: string, bg: Rgb) => contrastRatio(composite(parseColor(fg), bg), bg)

    // Syntax: every kind of text reads at 4.5:1 on the editor.
    const texts = [
      'Heading',
      'Head',
      'site',
      'https://example.com/page',
      'devot://note/abc',
      '---',
      'plain line',
    ]
    for (const text of texts) {
      const seen = await textStyle(page, text)
      expect(ratio(seen.color, surface), `${scheme} ${text}`).toBeGreaterThanOrEqual(4.5)
    }
    // Headings and table headers are not underlined: only links are.
    expect((await textStyle(page, 'Heading')).decoration).toBe('none')
    expect((await textStyle(page, 'Head')).decoration).toBe('none')

    // The active line is a tint, not a slab: its text still reads on it.
    const line = await partStyle(page, '.cm-activeLine')
    const lineBackground = rgb(line.background)
    expect(lineBackground).not.toEqual(surface)
    const onLine = await textStyle(page, 'plain line')
    expect(ratio(onLine.color, lineBackground), `${scheme} active line`).toBeGreaterThanOrEqual(4.5)

    // Gutter: its numbers, and the active line's cell.
    const gutters = await partStyle(page, '.cm-gutters')
    const gutterBackground = rgb(gutters.background)
    expect(ratio(gutters.color, gutterBackground), `${scheme} gutter`).toBeGreaterThanOrEqual(4.5)
    // The gutter is sticky: scrolled text passes under it and must not show through.
    const scrolled = await page.locator('.cm-scroller').evaluate((el) => {
      const scroller = el as unknown as { scrollLeft: number }
      scroller.scrollLeft = 300
      return scroller.scrollLeft
    })
    expect(scrolled).toBeGreaterThan(0)
    expect(parseColor(gutters.background).alpha, `${scheme} gutter is opaque`).toBe(1)
    const cell = await partStyle(page, '.cm-activeLineGutter')
    const cellBackground = composite(parseColor(cell.background), gutterBackground)
    expect(
      ratio(cell.color, cellBackground),
      `${scheme} active gutter cell`,
    ).toBeGreaterThanOrEqual(4.5)

    // Selection: it stands 1.3:1 from the editor and, under the active line's
    // tint (CodeMirror draws it in a layer below the lines), from the active line.
    await page.keyboard.press('ControlOrMeta+a')
    const painted = async () => {
      const selection = await partStyle(page, '.cm-selectionBackground')
      const fill = parseColor(selection.background)
      const on = composite({ ...fill, alpha: fill.alpha * Number(selection.opacity) }, surface)
      return [on, composite(parseColor(line.background), on)] as const
    }
    const [selected, selectedLine] = await painted()
    expect(contrastRatio(selected, surface), `${scheme} selection`).toBeGreaterThanOrEqual(1.3)
    expect(
      contrastRatio(selectedLine, lineBackground),
      `${scheme} selection on the active line`,
    ).toBeGreaterThanOrEqual(1.3)
    // Plain text, links and front-matter-grey text all keep 4.5:1 on it, also on the active line.
    const link = await textStyle(page, 'site')
    for (const [what, color] of [
      ['text', onLine.color],
      ['link', link.color],
      ['secondary', await themeColour(page, '--color-text-secondary')],
    ] as const) {
      for (const [where, bg] of [
        ['selection', selected],
        ['selection on the active line', selectedLine],
      ] as const) {
        expect(ratio(color, bg), `${scheme} ${what} on the ${where}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    // With the keyboard elsewhere the selection stays visible (at least 1.15:1).
    await page.locator('.cm-content').evaluate((el) => (el as unknown as { blur(): void }).blur())
    await expect(page.locator('.cm-editor')).not.toHaveClass(/cm-focused/)
    const [unfocused, unfocusedLine] = await painted()
    expect(contrastRatio(unfocused, surface), `${scheme} unfocused`).toBeGreaterThanOrEqual(1.15)
    expect(
      contrastRatio(unfocusedLine, lineBackground),
      `${scheme} unfocused on the active line`,
    ).toBeGreaterThanOrEqual(1.15)
    expect(await violations(page)).toEqual([])
  })
}
