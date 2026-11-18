import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'
import { pickPluginMenu, pluginFrame, servePlugins, type TestPlugin } from './plugins'

const mdxPlugin: TestPlugin = {
  manifest: JSON.parse(readFileSync('plugins/mdx/devot-plugin.json', 'utf8')) as Record<
    string,
    unknown
  > & { id: string },
  main: readFileSync('plugins/mdx/main.js', 'utf8'),
  files: {
    'panel.css': readFileSync('plugins/mdx/panel.css', 'utf8'),
    'README.md': readFileSync('plugins/mdx/README.md', 'utf8'),
  },
}

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })

const savedNotes = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
        title: string
        bodyMd: string
      }[],
  )

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) => window.devotIpcCalls.filter((call) => call.cmd === c).map((call) => call.args),
    cmd,
  )

async function noteWith(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await body(page).click()
  await page.keyboard.insertText(text)
  await expect.poll(async () => (await savedNotes(page))[0]?.bodyMd).toBe(text)
}

async function paletteRun(page: Page, label: string) {
  await page.keyboard.press('Meta+KeyK')
  await palette(page).getByRole('combobox', { name: 'Command Palette' }).fill(`> ${label}`)
  await palette(page)
    .getByRole('option', { name: new RegExp(label) })
    .first()
    .click()
}

test.beforeEach(async ({ page }) => {
  await servePlugins(page, [mdxPlugin])
  await page.addInitScript(() => {
    const w = window as unknown as {
      cspViolations: string[]
      devotIpcMocks: Record<string, unknown>
    }
    w.cspViolations = []
    window.addEventListener('securitypolicyviolation', (e) => {
      w.cspViolations.push(`${e.violatedDirective}:${e.blockedURI}`)
    })
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      plugin_import_pick: () => [
        {
          name: 'getting-started.mdx',
          text: [
            '---',
            'title: Getting Started',
            '---',
            '',
            "import { Callout } from '@/components/ui'",
            "export const version = '2.5'",
            '',
            '# Welcome to v{version}',
            '',
            '<Callout type="tip" title="Fast">',
            '  Ready in **seconds**.',
            '</Callout>',
          ].join('\n'),
        },
        {
          name: 'metadata-doc.mdx',
          text: "export const metadata = { title: 'Metadata Route' }\n\nRoute content.\n",
        },
      ],
      plugin_export_save: () => true,
    }
  })
  await openApp(page)
  await pluginFrame(page, 'community.mdx')
})

test.afterEach(async ({ page }) => {
  const violations = await page.evaluate(
    () => (window as unknown as { cspViolations: string[] }).cspViolations,
  )
  expect(violations).toEqual([])
})

test('imports .mdx files both losslessly and compiled to native Markdown', async ({ page }) => {
  await paletteRun(page, 'Import MDX Files…')
  await expect(noteRows(page)).toHaveCount(2)
  const lossless = await savedNotes(page)
  expect(lossless.map((n) => n.title).sort()).toEqual(['Getting Started', 'Metadata Route'])
  const importedMdx = lossless.find((n) => n.title === 'Getting Started')!
  expect(importedMdx.bodyMd).toContain('<Callout type="tip" title="Fast">')
  expect(await calls(page, 'plugin_import_pick')).toEqual([
    { plugin: 'community.mdx', format: 'mdx' },
  ])

  await paletteRun(page, 'Import MDX Files as Markdown…')
  await expect(noteRows(page)).toHaveCount(4)
  const allNotes = await savedNotes(page)
  const compiledOnes = allNotes.filter(
    (n) => n.title === 'Getting Started' && n.bodyMd.includes('> [!TIP]'),
  )
  expect(compiledOnes).toHaveLength(1)
  expect(compiledOnes[0]!.bodyMd).toContain('# Welcome to v2.5')
  expect(compiledOnes[0]!.bodyMd).not.toContain('import { Callout }')
})

test('renders MDX components, local JSX functions, expressions, and syntax-highlighted mdx-code in Preview', async ({
  page,
}) => {
  const sample = [
    '```mdx',
    "export const release = '4.0'",
    'export const TagPill = ({ text }) => <Badge>{text}</Badge>',
    '',
    '# Release {release} <TagPill text="Stable" />',
    '',
    '<Callout type="warning" title="Migration">',
    '  Use <Kbd>Cmd+K</Kbd> safely. <script>window.mdxBad = 1</script>',
    '</Callout>',
    '',
    '<Tabs items={["pnpm", "npm"]} defaultIndex={0}>',
    '  <Tab value="pnpm">Install via `pnpm`.</Tab>',
    '  <Tab value="npm">Install via `npm`.</Tab>',
    '</Tabs>',
    '',
    '<Steps>',
    '  <Step title="Build">Compile bundle.</Step>',
    '  <Step title="Verify">Run suite.</Step>',
    '</Steps>',
    '',
    '<CustomChart metric="latency" threshold={12}>',
    '  99th percentile chart.',
    '</CustomChart>',
    '```',
    '',
    '```mdx-code',
    'import { Callout } from "./ui"',
    '<Callout type="tip">Highlighted</Callout>',
    '```',
  ].join('\n')

  await noteWith(page, sample)
  await page.keyboard.press('Meta+KeyE')

  const preview = page.locator('.preview')
  const mdxBlock = preview.locator('.plugin-block[data-plugin="community.mdx/mdx"]')
  await expect(mdxBlock.locator('h1')).toContainText('Release 4.0')
  await expect(mdxBlock.locator('mark').first()).toHaveText('Stable')
  await expect(mdxBlock.locator('.alert.alert-warning')).toContainText('Migration')
  await expect(mdxBlock.locator('kbd')).toHaveText('Cmd+K')
  await expect(mdxBlock.locator('details[open] summary')).toHaveText('pnpm')
  await expect(mdxBlock).toContainText('Compile bundle.')
  await expect(mdxBlock).toContainText('<CustomChart>')
  await expect(mdxBlock).toContainText('99th percentile chart.')
  await expect(mdxBlock.locator('script')).toHaveCount(0)
  expect(await page.evaluate(() => (window as { mdxBad?: number }).mdxBad)).toBeUndefined()

  const codeBlock = preview.locator('.plugin-block[data-plugin="community.mdx/mdx-code"]')
  await expect(codeBlock.locator('.code-block .hljs-keyword').first()).toHaveText('import')
})

test('toggles MDX preview wrapper, compiles MDX, converts Markdown to MDX, exports .mdx, and supports single-step Undo', async ({
  page,
}) => {
  const rawMdx =
    '---\ntitle: Toggle Demo\n---\n\nexport const x = 9\n\n<Callout type="tip">Count {x}</Callout>'
  await noteWith(page, rawMdx)
  await page.getByRole('textbox', { name: 'Title' }).fill('Toggle Demo')
  await expect.poll(async () => (await savedNotes(page))[0]?.title).toBe('Toggle Demo')

  await page.keyboard.press('Meta+Control+Shift+KeyP')
  await expect
    .poll(async () => (await savedNotes(page))[0]?.bodyMd)
    .toContain('```mdx\nexport const x = 9')

  await paletteRun(page, 'Export Note as MDX')
  await expect
    .poll(() => calls(page, 'plugin_export_save'))
    .toEqual([
      {
        plugin: 'community.mdx',
        format: 'mdx',
        title: 'Toggle Demo',
        text: `${rawMdx}\n`,
      },
    ])

  await page.keyboard.press('Meta+Control+Shift+KeyP')
  await expect.poll(async () => (await savedNotes(page))[0]?.bodyMd).toBe(rawMdx)

  await page.keyboard.press('Meta+Control+Shift+KeyC')
  await expect.poll(async () => (await savedNotes(page))[0]?.bodyMd).toContain('> [!TIP]')
  await expect.poll(async () => (await savedNotes(page))[0]?.bodyMd).toContain('Count 9')

  await body(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(body(page)).toContainText('<Callout type="tip">Count {x}</Callout>')

  await pickPluginMenu(page, {
    kind: 'command',
    plugin: 'community.mdx',
    id: 'insert-callout',
  })
  await expect
    .poll(async () => (await savedNotes(page))[0]?.bodyMd)
    .toContain('Write your MDX note here.')
})

test('opens the interactive MDX Studio sheet with live tabs, syntax highlighting, diagnostics, and note actions', async ({
  page,
}) => {
  const doc = [
    '---',
    'title: Studio Check',
    '---',
    '',
    "import { Tabs, Tab } from './tabs'",
    'export const env = "production"',
    '',
    '<!-- html comment to flag -->',
    '',
    '<Tabs items={["First", "Second"]} defaultIndex={0}>',
    '  <Tab value="First">Alpha panel in {env}.</Tab>',
    '  <Tab value="Second">Beta panel content.</Tab>',
    '</Tabs>',
  ].join('\n')

  await noteWith(page, doc)
  await page.keyboard.press('Meta+Control+Shift+KeyM')

  const dialog = page.getByRole('dialog', { name: 'MDX' })
  await expect(dialog).toBeVisible()
  const iframe = dialog.locator('iframe.plugin-frame[data-plugin="community.mdx"]')
  await expect(iframe).toBeVisible()
  await expect(iframe).toHaveCSS('height', '520px')

  const inner = await pluginFrame(page, 'community.mdx')
  const firstPanel = inner.locator('.mdx-tab-panel').nth(0)
  const secondPanel = inner.locator('.mdx-tab-panel').nth(1)
  await expect(firstPanel).toBeVisible()
  await expect(firstPanel).toContainText('Alpha panel in production.')
  await expect(secondPanel).toBeHidden()

  await inner.getByRole('tab', { name: 'Second' }).click()
  await expect(secondPanel).toBeVisible()
  await expect(secondPanel).toContainText('Beta panel content.')
  await expect(firstPanel).toBeHidden()

  await inner.getByRole('tab', { name: 'Highlighted MDX' }).click()
  await expect(inner.locator('.mdx-tok-esm-keyword').first()).toHaveText('import')
  await expect(inner.locator('.mdx-tok-jsx-component').first()).toHaveText('Tabs')

  await inner.getByRole('tab', { name: /Inspector/ }).click()
  await expect(inner.locator('[data-stage="inspector"]')).toContainText('MDX_HTML_COMMENT')

  await inner.getByRole('button', { name: 'Convert to MDX' }).click()
  await expect
    .poll(async () => (await savedNotes(page))[0]?.bodyMd)
    .toContain('{/* html comment to flag */}')

  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
})
