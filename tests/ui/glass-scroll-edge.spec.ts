import { changeEditorSettingsElsewhere, expect, openApp, test } from './fixtures'

test('fades scrolled editor and preview independently', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(
    Array.from({ length: 100 }, (_, i) => `## Section ${i}\n\nParagraph ${i}`).join('\n\n'),
  )
  await page.getByRole('textbox', { name: 'Title' }).click()
  const mode = page.getByRole('group', { name: 'View mode' })
  await mode.getByRole('button', { name: 'Preview', exact: true }).click()
  const panes = page.locator('.panes')
  const preview = page.locator('.preview')
  await expect(preview.getByRole('heading', { name: 'Section 99' })).toBeAttached()
  await preview.evaluate((el) => {
    el.scrollTop = 100
  })
  await expect(page.locator('.content')).toHaveAttribute('data-scrolled')
  await expect(panes).toHaveCSS('--scroll-edge-size', '28px')
  // The scroll boxes carry the fade; the panes and the editor's host, which hold its popups, never do.
  await expect(preview).toHaveCSS('--scroll-edge-depth', '28px')
  await expect(preview).not.toHaveCSS('mask-image', 'none')
  await expect(panes).toHaveCSS('mask-image', 'none')
  await expect(page.locator('.editor')).toHaveCSS('mask-image', 'none')
  // A few pixels down, the first line is not yet at the edge: the fade is no deeper than the scroll.
  await preview.evaluate((el) => {
    el.scrollTop = 6
  })
  await expect(panes).toHaveCSS('--scroll-edge-size', '6px')
  await expect(preview).toHaveCSS('--scroll-edge-depth', '6px')
  await preview.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(page.locator('.content')).not.toHaveAttribute('data-scrolled')
  await expect(panes).toHaveCSS('--scroll-edge-size', '0px')
  await changeEditorSettingsElsewhere(page, { syncScroll: false })
  await mode.getByRole('button', { name: 'Split', exact: true }).click()
  await page.locator('.editor-scroll').evaluate((el) => {
    el.scrollTop = 100
  })
  await expect(panes).toHaveAttribute('data-editor-scrolled')
  await expect(page.locator('.editor')).toHaveCSS('--scroll-edge-size', '28px')
  await expect(page.locator('.editor-scroll')).toHaveCSS('--scroll-edge-depth', '28px')
  await expect(page.locator('.editor-scroll')).not.toHaveCSS('mask-image', 'none')
  await expect(page.locator('.editor')).toHaveCSS('mask-image', 'none')
  await page.locator('.editor-scroll').evaluate((el) => {
    el.scrollTop = 6
  })
  await expect(page.locator('.editor-scroll')).toHaveCSS('--scroll-edge-depth', '6px')
  await expect(preview).toHaveCSS('--scroll-edge-size', '0px')
  await preview.evaluate((el) => {
    el.scrollTop = 100
  })
  await expect(panes).toHaveAttribute('data-preview-scrolled')
  await expect(preview).toHaveCSS('--scroll-edge-size', '28px')
})

test('scrolling a split note past the fade depth restyles nothing', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(
    Array.from({ length: 200 }, (_, i) => `## Section ${i}\n\nParagraph ${i}`).join('\n\n'),
  )
  await page.getByRole('textbox', { name: 'Title' }).click()
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split', exact: true })
    .click()
  const panes = page.locator('.panes')
  const preview = page.locator('.preview')
  await expect(preview.getByRole('heading', { name: 'Section 199' })).toBeAttached()
  await preview.evaluate((el) => {
    el.scrollTop = 100
  })
  await expect(panes).toHaveAttribute('data-preview-scrolled')
  await expect(panes).toHaveAttribute('data-editor-scrolled')
  await expect(preview).toHaveCSS('--scroll-edge-size', '28px')
  await expect(page.locator('.editor')).toHaveCSS('--scroll-edge-size', '28px')
  // The depth stays on the pane it fades: the preview's blocks never inherit it.
  for (const name of ['--scrolled-by', '--preview-scrolled-by', '--pane-scrolled-by']) {
    await expect(page.locator('.preview-body')).toHaveCSS(name, '')
  }
  const restyled = await page.evaluate(async () => {
    const watched = ['.content', '.panes', '.panes > .editor', '.panes > .preview']
    const records: string[] = []
    const observer = new MutationObserver((changes) => {
      for (const change of changes) records.push((change.target as Element).className)
    })
    for (const selector of watched) {
      observer.observe(document.querySelector(selector)!, { attributes: true })
    }
    const scroller = document.querySelector<HTMLElement>('.panes > .preview')!
    const frame = () => new Promise((done) => requestAnimationFrame(() => done(undefined)))
    for (let top = 150; top <= 2000; top += 50) {
      scroller.scrollTop = top
      await frame()
      await frame()
    }
    observer.disconnect()
    return { records, top: scroller.scrollTop }
  })
  expect(restyled.top).toBeGreaterThan(1000)
  expect(restyled.records).toEqual([])
})
