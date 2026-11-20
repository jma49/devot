import corpus from '../fixtures/diagram-corpus.json' with { type: 'json' }
import { expect, openApp, test } from './fixtures'

const cases = [
  ['plantuml', 'plantuml', '@startuml\nAlice -> Bob: Hello\n@enduml', ['Alice', 'Bob', 'Hello']],
  ['puml', 'plantuml', '@startuml\nclass Note\nclass Tag\nNote --> Tag\n@enduml', ['Note', 'Tag']],
  [
    'markmap',
    'markmap',
    '# Notes\n## Ideas\n- Capture\n## Tasks\n- Ship',
    ['Notes', 'Capture', 'Ship'],
  ],
] as const

for (const [language, kind, source, labels] of cases) {
  test(`${language} draws offline in the sandbox`, async ({ page }) => {
    await openApp(page)
    await page.getByRole('button', { name: 'New Note', exact: true }).click()
    await page.getByRole('textbox', { name: 'Note body' }).click()
    await page.keyboard.insertText(`\`\`\`${language}\n${source}\n\`\`\``)
    await page
      .getByRole('group', { name: 'View mode' })
      .getByRole('button', { name: 'Preview', exact: true })
      .click()
    const svg = page.locator(`.island-${kind} svg`)
    await expect(svg).toBeVisible({ timeout: 30_000 })
    for (const label of labels) await expect(svg).toContainText(label)
    await expect(svg.locator('foreignObject, script, image')).toHaveCount(0)
    expect(await svg.locator('path, line').count()).toBeGreaterThan(0)
    const size = await svg.boundingBox()
    expect(size?.width).toBeGreaterThan(30)
    expect(size?.height).toBeGreaterThan(30)
  })
}

for (const { name, kind, source } of corpus) {
  test(`${name} preserves the frame's elements and attributes`, async ({ page }) => {
    await page.addInitScript(() => {
      const host = window as unknown as { diagramAnswers: string[] }
      host.diagramAnswers = []
      const Channel = window.MessageChannel
      window.MessageChannel = class extends Channel {
        constructor() {
          super()
          this.port1.addEventListener('message', (event) => {
            if (event.data?.type === 'rendered' && typeof event.data.svg === 'string')
              host.diagramAnswers.push(event.data.svg)
          })
        }
      }
    })
    await openApp(page)
    await page.getByRole('button', { name: 'New Note', exact: true }).click()
    await page.getByRole('textbox', { name: 'Note body' }).click()
    await page.keyboard.insertText(`\`\`\`${kind}\n${source}\n\`\`\``)
    await page
      .getByRole('group', { name: 'View mode' })
      .getByRole('button', { name: 'Preview', exact: true })
      .click()
    const svg = page.locator(`.island-${kind} svg`)
    await expect(svg).toBeVisible({ timeout: 30_000 })
    const comparison = await svg.evaluate((imported) => {
      const host = window as unknown as { diagramAnswers: string[] }
      const raw = new DOMParser().parseFromString(
        host.diagramAnswers.at(-1)!,
        'image/svg+xml',
      ).documentElement
      function structure(node: Element): unknown {
        return {
          tag: node.localName,
          attributes: Array.from(node.attributes, (attr) => attr.name)
            .filter(
              (attribute) =>
                !attribute.startsWith('xmlns') &&
                attribute !== 'aria-label' &&
                attribute !== 'aria-labelledby' &&
                attribute !== 'role' &&
                !(attribute === 'style' && !(node as SVGElement).style.cssText),
            )
            .sort(),
          text: node.children.length ? null : node.textContent,
          children: Array.from(node.children)
            .filter((child) => child.localName !== 'style')
            .map(structure),
        }
      }
      return { frame: structure(raw), imported: structure(imported) }
    })
    expect(comparison.imported).toEqual(comparison.frame)
  })
}
