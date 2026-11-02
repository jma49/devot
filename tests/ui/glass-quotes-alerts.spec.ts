import type { Locator, Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, openApp, test } from './fixtures'

const KINDS = ['note', 'tip', 'important', 'warning', 'caution']
const ALERTS = KINDS.map((kind) => `> [!${kind.toUpperCase()}]\n> About ${kind}.`).join('\n\n')
const DOC = `> A quote that runs\n> over two lines.\n\n${ALERTS}\n\nAfter.`
const TRANSPARENT = 'rgba(0, 0, 0, 0)'
const SCREENSHOTS = '/tmp/devot-agents/gap10'

const before = (target: Locator, property: string) =>
  target.evaluate(
    (el, name) =>
      (el.ownerDocument.defaultView as Window)
        .getComputedStyle(el, '::before')
        .getPropertyValue(name),
    property,
  )

async function openNote(page: Page, text = DOC) {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(text)
}

const showPreview = (page: Page) =>
  page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Preview', exact: true })
    .click()

test('Glass preview draws tinted alert cards and a straight quote bar', async ({ page }) => {
  await openNote(page)
  await showPreview(page)

  const quote = page.locator('.preview blockquote')
  await expect(quote).toHaveCSS('border-left-width', '0px')
  await expect(quote).toHaveCSS('padding-left', '18px')
  expect(await before(quote, 'width')).toBe('3px')
  expect(await before(quote, 'border-top-left-radius')).toBe('2px')
  expect(await before(quote, 'top')).toBe('2px')
  expect(await before(quote, 'bottom')).toBe('2px')

  const text = await page.locator('.preview').evaluate((el) => getComputedStyle(el).color)
  for (const kind of KINDS) {
    const alert = page.locator(`.preview .alert-${kind}`)
    await expect(alert).toHaveCSS('border-radius', '12px')
    await expect(alert).toHaveCSS('border-left-width', '0px')
    await expect(alert).toHaveCSS('padding', '11px 14px 12px')
    await expect(alert).not.toHaveCSS('background-color', TRANSPARENT)
    await expect(alert).toHaveCSS('box-shadow', /inset/)
    await expect(alert.locator('> p:not(.alert-title)')).toHaveCSS('color', text)
    await expect(alert.locator('.alert-title')).toHaveCSS('font-weight', '600')
  }

  const gaps = await page.locator('.preview .alert').evaluateAll((alerts) =>
    alerts.slice(1).map((alert, i) => {
      const above = alerts[i] as Element
      return alert.getBoundingClientRect().top - above.getBoundingClientRect().bottom
    }),
  )
  expect(gaps).toEqual([10, 10, 10, 10])
  await page.screenshot({ path: `${SCREENSHOTS}/preview-glass-light.png` })
})

test('Classic preview keeps the border bars', async ({ page }) => {
  await openNote(page)
  await showPreview(page)
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })

  const quote = page.locator('.preview blockquote')
  await expect(quote).toHaveCSS('border-left-width', '3px')
  await expect(quote).toHaveCSS('padding-left', '12px')
  expect(await before(quote, 'content')).toBe('none')
  for (const kind of KINDS) {
    const alert = page.locator(`.preview .alert-${kind}`)
    await expect(alert).toHaveCSS('border-left-width', '3px')
    await expect(alert).toHaveCSS('border-radius', '0px')
    await expect(alert).toHaveCSS('background-color', TRANSPARENT)
    await expect(alert).toHaveCSS('box-shadow', 'none')
    await expect(alert).toHaveCSS('padding', '2px 0px 2px 12px')
  }
  await page.screenshot({ path: `${SCREENSHOTS}/preview-classic.png` })
})

test('Glass editor rounds the quote bar and tints alert lines as one card', async ({ page }) => {
  await openNote(page)
  await changeEditorSettingsElsewhere(page, { highlightActiveLine: true })

  const quote = page.locator('.cm-line.cm-md-quote:not(.cm-md-alert)')
  await expect(quote).toHaveCount(2)
  expect(await before(quote.first(), 'width')).toBe('3px')
  expect(await before(quote.first(), 'top')).toBe('2px')
  expect(await before(quote.first(), 'border-top-left-radius')).toBe('2px')
  expect(await before(quote.first(), 'bottom')).toBe('0px')
  expect(await before(quote.last(), 'bottom')).toBe('2px')
  expect(await before(quote.last(), 'border-bottom-left-radius')).toBe('2px')

  for (const kind of KINDS) {
    const lines = page.locator(`.cm-line.cm-md-alert-${kind}`)
    await expect(lines).toHaveCount(2)
    expect(await before(lines.first(), 'background-color')).not.toBe(TRANSPARENT)
    expect(await before(lines.first(), 'border-top-left-radius')).toBe('12px')
    expect(await before(lines.first(), 'border-top-width')).toBe('1px')
    expect(await before(lines.first(), 'border-bottom-width')).toBe('0px')
    expect(await before(lines.last(), 'border-bottom-right-radius')).toBe('12px')
    expect(await before(lines.last(), 'border-bottom-width')).toBe('1px')
    expect(await before(lines.last(), 'border-top-width')).toBe('0px')
    expect(await before(lines.first(), 'z-index')).toBe('-2')
    await expect(lines.first()).toHaveCSS('z-index', 'auto')
  }

  await page.locator('.cm-line.cm-md-alert-tip').last().click()
  const active = page.locator('.cm-line.cm-activeLine')
  await expect(active).toHaveClass(/cm-md-alert-tip/)
  await expect(active).toHaveCSS('background-color', TRANSPARENT)

  const edges = await page.locator('.cm-line.cm-md-alert-note').evaluateAll((lines) =>
    lines.map((line) => {
      const box = line.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom }
    }),
  )
  expect(edges[1]!.top).toBe(edges[0]!.bottom)
  await page.screenshot({ path: `${SCREENSHOTS}/editor-glass-light.png` })
})

test('Classic editor keeps the square bars', async ({ page }) => {
  await openNote(page)
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: false, highlightActiveLine: true })

  const quote = page.locator('.cm-line.cm-md-quote:not(.cm-md-alert)').first()
  await expect.poll(() => before(quote, 'top')).toBe('0px')
  expect(await before(quote, 'width')).toBe('3px')
  expect(await before(quote, 'border-top-left-radius')).toBe('0px')

  const line = page.locator('.cm-line.cm-md-alert-note').first()
  const colour = await page.evaluate(() => {
    const probe = document.createElement('i')
    probe.style.color = 'var(--color-alert-note)'
    document.body.append(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  })
  expect(await before(line, 'background-color')).toBe(colour)
  expect(await before(line, 'width')).toBe('3px')
  expect(await before(line, 'border-top-left-radius')).toBe('0px')
  expect(await before(line, 'border-top-width')).toBe('0px')
  await line.click()
  await expect(page.locator('.cm-line.cm-activeLine')).not.toHaveCSS(
    'background-color',
    TRANSPARENT,
  )
  await page.screenshot({ path: `${SCREENSHOTS}/editor-classic.png` })
})
