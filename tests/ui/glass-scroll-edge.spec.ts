import { changeEditorSettingsElsewhere, expect, openApp, test } from './fixtures'

test('fades scrolled editor and preview independently, and restores the Classic edge', async ({
  page,
}) => {
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
  await preview.evaluate((el) => {
    el.scrollTop = 100
  })
  await expect(page.locator('.content')).toHaveAttribute('data-scrolled')
  await expect(panes).toHaveCSS('--scroll-edge-size', '28px')
  await expect(panes).not.toHaveCSS('mask-image', 'none')
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
  await expect(preview).toHaveCSS('--scroll-edge-size', '0px')
  await preview.evaluate((el) => {
    el.scrollTop = 100
  })
  await expect(panes).toHaveAttribute('data-preview-scrolled')
  await expect(preview).toHaveCSS('--scroll-edge-size', '28px')
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
  await expect(panes).toHaveCSS('mask-image', 'none')
  await expect(preview).toHaveCSS('mask-image', 'none')
  await expect(page.locator('.editor')).toHaveCSS('mask-image', 'none')
})
