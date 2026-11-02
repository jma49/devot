import type { Locator, Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test } from './fixtures'

type Styles = {
  getComputedStyle(el: unknown): { color: string; backgroundColor: string }
  document: {
    documentElement: unknown
    createElement(tag: string): { style: { color: string }; remove(): void }
    body: { appendChild(el: unknown): void }
  }
}

/** A token as the page paints it, so the comparison holds in any appearance. */
const token = (page: Page, name: string) =>
  page.evaluate((variable) => {
    const { document, getComputedStyle } = globalThis as unknown as Styles
    const probe = document.createElement('span')
    probe.style.color = `var(${variable})`
    document.body.appendChild(probe)
    const { color } = getComputedStyle(probe)
    probe.remove()
    return color
  }, name)

/** An icon is a mask painted with its background (SF Symbols) or an SVG in its colour (Lucide). */
const iconColour = (icon: Locator) =>
  icon.evaluate((el) => {
    const { getComputedStyle } = globalThis as unknown as Styles
    const style = getComputedStyle(el)
    return (el as unknown as { classList: { contains(c: string): boolean } }).classList.contains(
      'icon-svg',
    )
      ? style.color
      : style.backgroundColor
  })

const sourceIcon = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Sidebar' })
    .locator('.source', { hasText: name })
    .locator('.icon, .icon-svg')
    .first()

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} appearance`, () => {
    test.use({ colorScheme })

    test('in Glass, sidebar icons are secondary, the selected one accent, and counts tertiary', async ({
      page,
    }) => {
      await page.goto('/')
      const allNotes = sourceIcon(page, 'All Notes')
      await expect(allNotes).toBeVisible()
      const secondary = await token(page, '--color-text-secondary')
      const accent = await token(page, '--color-accent-text')
      const sidebar = page.getByRole('navigation', { name: 'Sidebar' })

      await expect.poll(() => iconColour(allNotes)).toBe(accent)
      await expect.poll(() => iconColour(sourceIcon(page, 'Templates'))).toBe(secondary)
      await expect(sidebar.locator('.source-count').first()).toHaveCSS(
        'color',
        await token(page, '--color-text-tertiary'),
      )
      await expect
        .poll(() => iconColour(sourceIcon(page, 'Active')))
        .toBe(await token(page, '--color-status-active-mark'))

      await sidebar.locator('.source', { hasText: 'Templates' }).click()
      await expect.poll(() => iconColour(sourceIcon(page, 'Templates'))).toBe(accent)
      await expect.poll(() => iconColour(allNotes)).toBe(secondary)
    })

    test('in Glass, a selected status keeps its status colour', async ({ page }) => {
      await page.goto('/')
      const active = sourceIcon(page, 'Active')
      await expect(active).toBeVisible()
      await page
        .getByRole('navigation', { name: 'Sidebar' })
        .locator('.source', { hasText: 'Active' })
        .click()
      await expect
        .poll(() => iconColour(active))
        .toBe(await token(page, '--color-status-active-mark'))
    })

    test('in Glass, only the active view segment in the toolbar is accent', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'New Note', exact: true }).click()
      const modes = page.getByRole('group', { name: 'View mode' })
      await modes.getByRole('button', { name: 'Preview', exact: true }).click()
      const accent = await token(page, '--color-accent-text')
      const secondary = await token(page, '--color-text-secondary')
      await expect(modes.getByRole('button', { name: 'Preview', exact: true })).toHaveCSS(
        'color',
        accent,
      )
      await expect(modes.getByRole('button', { name: 'Split', exact: true })).toHaveCSS(
        'color',
        secondary,
      )
      const focus = page.locator('.toolbar .tool[aria-pressed]').first()
      await focus.click()
      await expect(focus).toHaveAttribute('aria-pressed', 'true')
      await expect(focus).toHaveCSS('color', secondary)
    })

    test('Classic keeps the accent on sidebar icons and secondary counts', async ({ page }) => {
      await page.goto('/')
      await expect(sourceIcon(page, 'Templates')).toBeVisible()
      await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
      const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
      await expect
        .poll(() => iconColour(sourceIcon(page, 'Templates')))
        .toBe(await token(page, '--color-accent-text'))
      await expect(sidebar.locator('.source-count').first()).toHaveCSS(
        'color',
        await token(page, '--color-text-secondary'),
      )
    })
  })
}
