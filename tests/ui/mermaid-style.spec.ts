import type { Locator, Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, openApp, test } from './fixtures'

const DIAGRAM = '```mermaid\nflowchart LR\n  A[Idea] --> B[Draft]\n  B -->|changes| C[Review]\n```'

type Style = Record<string, string>
const computed = (target: Locator, property: string) =>
  target.evaluate(
    (el, name) =>
      (el.ownerDocument.defaultView as Window).getComputedStyle(el).getPropertyValue(name),
    property,
  )

/** A token as the page paints it. */
const token = (page: Page, name: string) =>
  page.evaluate((variable) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${variable})`
    document.body.appendChild(probe)
    const { color } = getComputedStyle(probe) as unknown as Style
    probe.remove()
    return color!
  }, name)

async function openDiagram(page: Page) {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(DIAGRAM)
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Preview', exact: true })
    .click()
  const svg = page.locator('.island-mermaid svg')
  await expect(svg).toBeVisible({ timeout: 20_000 })
  return svg
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} appearance`, () => {
    test.use({ colorScheme })

    test('a diagram is drawn in the house style', async ({ page }) => {
      const svg = await openDiagram(page)
      const node = svg.locator('.node rect.label-container').first()
      await expect.poll(() => computed(node, 'rx')).toBe('9px')
      expect(await computed(node, 'fill')).toBe(await token(page, '--color-fill-card'))
      expect(await computed(node, 'stroke')).toBe(await token(page, '--color-line-hairline'))
      expect(await computed(node, 'stroke-width')).toBe('0.5px')

      const text = svg.locator('.node .label text').first()
      expect(await computed(text, 'font-size')).toBe('12px')
      expect(await computed(text, 'font-family')).toContain('apple-system')
      expect(await computed(text, 'fill')).toBe(await token(page, '--color-text-primary'))

      const edge = svg.locator('.flowchart-link').first()
      expect(await computed(edge, 'stroke')).toBe(await token(page, '--color-text-tertiary'))
      expect(await computed(edge, 'stroke-width')).toBe('1px')

      const label = svg.locator('.edgeLabel text').first()
      expect(await computed(label, 'font-size')).toBe('11px')
      expect(await computed(label, 'fill')).toBe(await token(page, '--color-text-secondary'))
      const background = svg.locator('.edgeLabel rect.background').first()
      expect(await computed(background, 'fill')).toBe('none')
    })

    test('an edge label sits beside its line and arrowheads are small', async ({ page }) => {
      const svg = await openDiagram(page)
      const marker = svg.locator('marker[id$="-pointEnd-margin"]').first()
      expect(await marker.getAttribute('markerWidth')).toBe('6')
      expect(await marker.getAttribute('markerHeight')).toBe('8')

      const overlaps = await svg.evaluate((root) => {
        const box = root.querySelector('.edgeLabel rect.background')!.getBoundingClientRect()
        const scale =
          root.getBoundingClientRect().width /
          (root as unknown as SVGSVGElement).viewBox.baseVal.width
        const path = root.querySelector<SVGPathElement>('[data-id="L_B_C_0"].flowchart-link')!
        const matrix = path.getScreenCTM()!
        const length = path.getTotalLength()
        let hits = 0
        for (let at = 0; at <= length; at += 1 / scale) {
          const point = path.getPointAtLength(at).matrixTransform(matrix)
          if (
            point.x >= box.left &&
            point.x <= box.right &&
            point.y >= box.top &&
            point.y <= box.bottom
          )
            hits += 1
        }
        return hits
      })
      expect(overlaps).toBe(0)
      const fits = await svg.evaluate((root) => {
        const frame = root.getBoundingClientRect()
        const box = root.querySelector('.edgeLabel rect.background')!.getBoundingClientRect()
        return box.bottom <= frame.bottom + 0.5 && box.right <= frame.right + 0.5
      })
      expect(fits).toBe(true)
    })
  })
}

test('a diagram follows a change of appearance and of theme', async ({ page }) => {
  const svg = await openDiagram(page)
  const node = svg.locator('.node rect.label-container').first()
  await changeEditorSettingsElsewhere(page, { appearance: 'dark' })
  await expect
    .poll(async () => computed(svg.locator('.node rect.label-container').first(), 'fill'))
    .toBe(await token(page, '--color-fill-card'))
  await changeEditorSettingsElsewhere(page, { appearance: 'dark', darkTheme: 'ivory' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ivory')
  const ivory = await token(page, '--color-fill-card')
  await expect
    .poll(async () => computed(svg.locator('.node rect.label-container').first(), 'fill'))
    .toBe(ivory)
  await expect(node).toBeVisible()
})
