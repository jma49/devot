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
