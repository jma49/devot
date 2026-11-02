import type { Locator, Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, openApp, test } from './fixtures'

const GANTT = `gantt
  title Plan
  dateFormat YYYY-MM-DD
  section Design
  Study :done, a1, 2026-01-01, 12d
  Tokens :active, a2, 2026-01-13, 12d
  section Build
  Code :b1, 2026-01-25, 12d
  Check :crit, b2, 2026-02-06, 12d
  Old :crit, done, b3, 2026-02-18, 12d
  Fix :crit, active, b4, 2026-03-02, 12d`
const PIE = `pie title Week
  "Writing" : 40
  "Reading" : 30
  "Review" : 20
  "Other" : 10`
const FLOW = 'flowchart LR\n  A[Idea] --> B[Draft]\n  B -->|changes| C[Review]'
const GIT = `gitGraph
  commit
  branch develop
  commit
  checkout main
  merge develop`
const TIMELINE = `timeline
  2025 : First : Second
  2026 : Third`
const MINDMAP = `mindmap
  root((Devot))
    Notes
      Tags
    Sync`
const JOURNEY = `journey
  section Capture
    Open app: 5: Me
  section Refine
    Add diagram: 2: Me`

type Rgb = [number, number, number]
const channels = (css: string): Rgb => {
  const parts = /rgba?\(([^)]+)\)/
    .exec(css)![1]!
    .split(/[\s,/]+/)
    .map(Number)
  return [parts[0]!, parts[1]!, parts[2]!]
}
const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
const computed = (target: Locator, property: string) =>
  target.evaluate(
    (el, name) =>
      (el.ownerDocument.defaultView as Window).getComputedStyle(el).getPropertyValue(name),
    property,
  )

async function openDiagrams(page: Page, ...sources: string[]) {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(sources.map((s) => `\`\`\`mermaid\n${s}\n\`\`\`\n`).join('\n'))
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Preview', exact: true })
    .click()
  const svgs = page.locator('.island-mermaid svg')
  await expect(svgs).toHaveCount(sources.length, { timeout: 20_000 })
  return svgs
}

/** Every bar and the text drawn on it: the text must read on the bar, whichever state it is in. */
async function barContrasts(svg: Locator) {
  const pairs = await svg.evaluate((root) => {
    const view = root.ownerDocument.defaultView as Window
    const bars = Array.from(root.querySelectorAll('rect.task'))
    return bars.map((bar) => {
      const label = root.querySelector(`[id="${bar.id}-text"]`)!
      const box = bar.getBoundingClientRect()
      const text = label.getBoundingClientRect()
      return {
        id: bar.id,
        bar: view.getComputedStyle(bar).fill,
        stroke: view.getComputedStyle(bar).strokeWidth,
        text: view.getComputedStyle(label).fill,
        inside: text.left >= box.left - 1 && text.right <= box.right + 1,
      }
    })
  })
  return pairs
}

const THEMES = [
  ['system light', 'light', undefined],
  ['system dark', 'dark', undefined],
  ['ivory light', 'light', 'ivory'],
  ['ivory dark', 'dark', 'ivory'],
] as const

for (const [name, appearance, theme] of THEMES) {
  test.describe(name, () => {
    test.use({ colorScheme: appearance })

    test('charts read in this theme', async ({ page }) => {
      const svgs = await openDiagrams(page, GANTT, PIE)
      if (theme) {
        const key = appearance === 'dark' ? 'darkTheme' : 'lightTheme'
        await changeEditorSettingsElsewhere(page, { appearance, [key]: theme })
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      }
      await expect(svgs).toHaveCount(2)

      const surface = channels(
        await page.evaluate(() => {
          const probe = document.createElement('span')
          probe.style.color = 'var(--color-surface-editor)'
          document.body.appendChild(probe)
          const { color } = getComputedStyle(probe)
          probe.remove()
          return color
        }),
      )
      await expect.poll(async () => (await barContrasts(svgs.nth(0))).length).toBeGreaterThan(0)
      await expect
        .poll(async () => {
          const bars = await barContrasts(svgs.nth(0))
          return bars
            .filter((bar) => bar.inside)
            .map((bar) => ({
              id: bar.id,
              // A done bar is translucent: its text is read against the surface it lets through.
              enough:
                contrast(
                  channels(bar.text),
                  bar.bar.includes('rgba') ? surface : channels(bar.bar),
                ) >= 4.5,
            }))
            .filter((bar) => !bar.enough)
        })
        .toEqual([])
      for (const bar of await barContrasts(svgs.nth(0))) expect(bar.stroke).toBe('0px')

      const pie = svgs.nth(1)
      const slice = pie.locator('.pieCircle').first()
      expect(await computed(slice, 'opacity')).toBe('1')
      expect(await computed(slice, 'stroke-width')).toBe('0px')
      const gaps = await pie.evaluate((root) => {
        const group = root.querySelector('.pieCircle')!.parentElement!
        const reference = /url\(["']?#([^"')]+)/.exec(group.getAttribute('mask') ?? '')?.[1]
        const mask = reference ? root.querySelector(`[id="${reference}"]`) : null
        const cuts = Array.from(mask?.querySelectorAll('path') ?? [])
        return {
          slices: root.querySelectorAll('.pieCircle').length,
          cuts: cuts.length,
          width: cuts[0]?.getAttribute('stroke-width'),
        }
      })
      expect(gaps).toEqual({ slices: 4, cuts: 4, width: '2' })
      expect(await computed(pie.locator('.pieOuterCircle'), 'stroke-width')).toBe('0px')
      expect(await computed(pie.locator('.legend rect').first(), 'opacity')).toBe('1')
      const legend = await computed(pie.locator('.legend rect').first(), 'fill')
      expect(await computed(slice, 'fill')).toBe(legend)
    })
  })
}

test('a gantt chart is drawn for its pane and its dates do not collide', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 })
  const svgs = await openDiagrams(page, GANTT)
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split', exact: true })
    .click()
  const svg = page.locator('.island-mermaid svg').first()
  await expect(svg).toBeVisible()
  await expect
    .poll(() =>
      svg.evaluate((root) => {
        const shown = root.getBoundingClientRect().width
        const drawn = (root as unknown as SVGSVGElement).viewBox.baseVal.width
        return Math.abs(shown / drawn - 1)
      }),
    )
    .toBeLessThan(0.1)
  const collisions = await svgs.first().evaluate((root) => {
    const boxes = Array.from(root.querySelectorAll('.grid .tick text'))
      .map((text) => text.getBoundingClientRect())
      .filter((box) => box.width > 0)
      .sort((a, b) => a.left - b.left)
    return boxes.filter((box, i) => i > 0 && box.left < boxes[i - 1]!.right).length
  })
  expect(collisions).toBe(0)
})

test('the today line runs under the bars', async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10)
  const svgs = await openDiagrams(
    page,
    `gantt\n  dateFormat YYYY-MM-DD\n  section S\n  Now :active, a, ${today}, 3d`,
  )
  const under = await svgs.first().evaluate((root) => {
    const line = root.querySelector('.today')!
    const bar = root.querySelector('rect.task')!
    return Boolean(line.compareDocumentPosition(bar) & 4)
  })
  expect(under).toBe(true)
})

test('an edge label clears its line by the line width and paints nothing over it', async ({
  page,
}) => {
  const svgs = await openDiagrams(page, FLOW)
  const svg = svgs.first()
  const background = svg.locator('.edgeLabel rect.background').first()
  expect(await computed(background, 'fill')).toBe('none')
  const clearance = await svg.evaluate((root) => {
    const text = root.querySelector('.edgeLabel text')!.getBoundingClientRect()
    const line = root.querySelector('[data-id="L_B_C_0"].flowchart-link')!.getBoundingClientRect()
    const scale =
      root.getBoundingClientRect().width / (root as unknown as SVGSVGElement).viewBox.baseVal.width
    return (text.top - line.bottom) / scale
  })
  expect(clearance).toBeGreaterThanOrEqual(0)
})

test('derived Mermaid colours do not leak into the other charts', async ({ page }) => {
  const svgs = await openDiagrams(page, GIT, TIMELINE, MINDMAP, JOURNEY)
  const git = svgs.nth(0)
  expect(await computed(git.locator('.arrow').first(), 'stroke-width')).toBe('3px')
  const tagBlue = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--color-tag-blue)'
    document.body.appendChild(probe)
    const { color } = getComputedStyle(probe)
    probe.remove()
    return color
  })
  const fills = await git.evaluate((root) => {
    const view = root.ownerDocument.defaultView as Window
    return Array.from(root.querySelectorAll('circle')).map((c) => view.getComputedStyle(c).fill)
  })
  expect(fills).not.toContain(tagBlue)

  const timeline = svgs.nth(1)
  expect(await computed(timeline.locator('.eventWrapper').first(), 'filter')).toBe('none')

  for (const svg of [svgs.nth(1), svgs.nth(2)]) {
    const pairs = await svg.evaluate((root) => {
      const view = root.ownerDocument.defaultView as Window
      return Array.from(root.querySelectorAll('[class*="section-"] .node-bkg'))
        .filter((shape) => !shape.closest('.section-root'))
        .map((shape) => ({
          shape,
          label: shape.closest('[class*="section-"]')!.querySelector('text'),
        }))
        .filter(({ label }) => label !== null)
        .map(({ shape, label }) => ({
          bar: view.getComputedStyle(shape).fill,
          text: view.getComputedStyle(label!).fill,
        }))
    })
    expect(pairs.length).toBeGreaterThan(0)
    for (const pair of pairs)
      expect(contrast(channels(pair.text), channels(pair.bar))).toBeGreaterThanOrEqual(4.5)
  }

  const journey = svgs.nth(3)
  const labels = await journey.evaluate((root) => {
    const view = root.ownerDocument.defaultView as Window
    return Array.from(root.querySelectorAll('text'))
      .filter((text) => /Open app|Add diagram/.test(text.textContent ?? ''))
      .map((text) => {
        const shape = text.parentElement!.querySelector('rect')!
        return {
          text: view.getComputedStyle(text).fill,
          shape: view.getComputedStyle(shape).fill,
        }
      })
  })
  expect(labels.length).toBe(2)
  for (const label of labels)
    expect(contrast(channels(label.text), channels(label.shape))).toBeGreaterThanOrEqual(4.5)
})
