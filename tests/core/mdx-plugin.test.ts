import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import fc from 'fast-check'
import { toHtml } from 'hast-util-to-html'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  createClock,
  createIdGenerator,
  createNoteService,
  createPreviewRegistry,
  renderPreview,
} from '../../src/core'
import { captureNote } from '../../src/core/capture'
import { isPackagePath, parseManifest, type InstalledPlugin } from '../../src/core/plugins/manifest'
import { checkResult } from '../../src/core/plugins/protocol'
import { COMMANDS, commandKeys, RESERVED_KEYS } from '../../src/renderer/src/commands/registry'
import {
  pluginItems,
  pluginKeys,
  rendererSpecs,
} from '../../src/renderer/src/plugins/contributions'
import { labels } from '../support/preview-html'
import { openSqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

interface MdxDiagnostic {
  severity: 'error' | 'warning'
  code: string
  message: string
  line: number
  column: number
}

interface MdxInspection {
  title: string
  frontMatter: Record<string, unknown> | null
  imports: { raw: string; source: string; specifiers: string[]; line: number }[]
  exports: { name: string; kind: string; line: number; valuePreview: string }[]
  components: { name: string; count: number; lines: number[]; builtin: boolean }[]
  diagnostics: MdxDiagnostic[]
}

interface DevotMdxApi {
  parseFrontMatter(source: string): {
    yaml: string | null
    data: Record<string, unknown>
    body: string
    endLine: number
  }
  extractTitle(source: string, fileName?: string): string
  evaluateExpression(
    expr: string,
    scope?: Record<string, unknown>,
  ): { ok: true; value: unknown } | { ok: false; error: string }
  inspectMdx(source: string): MdxInspection
  highlightMdx(source: string): {
    html: string
    lineCount: number
    tokens: { type: string; value: string; line: number }[]
  }
  compileMdxToMarkdown(source: string, options?: { includeFrontMatterSummary?: boolean }): string
  renderPreviewBlock(source: string, mode?: 'mdx' | 'mdx-code' | 'mdx-source'): string
  renderStudioHtml(source: string): {
    previewHtml: string
    highlightedHtml: string
    compiledMarkdown: string
    inspection: MdxInspection
  }
  convertImport(
    format: 'mdx' | 'mdx-markdown',
    file: { name: string; text: string },
  ): { title: string; markdown: string }
  convertExport(format: 'mdx', note: { title: string; markdown: string }): string
  convertMarkdownToMdx(source: string): string
  togglePreviewBlock(source: string): { wrapped: boolean; markdown: string }
}

const PLUGIN_DIR = 'plugins/mdx'

function walkPluginFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const rel = `${prefix}${entry.name}`
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkPluginFiles(full, `${rel}/`))
    else out.push(rel)
  }
  return out.sort()
}

let mdx: DevotMdxApi

beforeAll(async () => {
  await import(pathToFileURL(join(PLUGIN_DIR, 'main.js')).href)
  mdx = (globalThis as unknown as { DevotMdx: DevotMdxApi }).DevotMdx
})

describe('MDX plugin package and manifest rules (ADR 0005)', () => {
  it('ships a valid package folder within every size, path and manifest rule', () => {
    expect(existsSync(join(PLUGIN_DIR, 'devot-plugin.json'))).toBe(true)
    const rawManifest = JSON.parse(
      readFileSync(join(PLUGIN_DIR, 'devot-plugin.json'), 'utf8'),
    ) as unknown
    const manifest = parseManifest(rawManifest)
    expect(manifest.id).toBe('community.mdx')
    expect(manifest.apiVersion).toBe(2)
    expect(manifest.contributes.slashMenu.map((s) => s.command)).toEqual([
      'insert-callout',
      'insert-tabs',
      'insert-steps',
    ])
    expect(existsSync(join(PLUGIN_DIR, manifest.main))).toBe(true)

    const files = walkPluginFiles(PLUGIN_DIR)
    expect(files.length).toBeGreaterThanOrEqual(3)
    expect(files.length).toBeLessThanOrEqual(256)

    let totalBytes = 0
    for (const rel of files) {
      expect(isPackagePath(rel)).toBe(true)
      const size = statSync(join(PLUGIN_DIR, rel)).size
      expect(size).toBeLessThanOrEqual(5 * 1024 * 1024)
      totalBytes += size
    }
    expect(totalBytes).toBeLessThanOrEqual(20 * 1024 * 1024)
  })

  it('contributes non-clashing keymaps, preview renderers, commands, and import/export formats', () => {
    const manifest = parseManifest(
      JSON.parse(readFileSync(join(PLUGIN_DIR, 'devot-plugin.json'), 'utf8')) as unknown,
    )
    const installed: InstalledPlugin = {
      manifest,
      enabled: true,
      granted: [...manifest.permissions],
    }
    const takenByApp = (key: string) =>
      RESERVED_KEYS.includes(key) || COMMANDS.some((c) => commandKeys(c.id).includes(key))

    const { keys, dropped } = pluginKeys([installed], takenByApp)
    expect(dropped).toEqual([])
    expect(keys.length).toBe(manifest.contributes.keymaps.length)

    const specs = rendererSpecs([installed])
    expect(specs.map((s) => s.language)).toEqual(['mdx', 'mdx-code', 'mdx-source'])

    const items = pluginItems([installed])
    expect(items.filter((i) => i.kind === 'import').map((i) => i.id)).toEqual([
      'mdx',
      'mdx-markdown',
    ])
    expect(items.filter((i) => i.kind === 'export').map((i) => i.id)).toEqual(['mdx'])
  })

  it('uses no eval or Function constructor anywhere in the plugin package', () => {
    for (const rel of walkPluginFiles(PLUGIN_DIR).filter((f) => f.endsWith('.js'))) {
      const code = readFileSync(join(PLUGIN_DIR, rel), 'utf8')
      expect(code).not.toMatch(/\beval\s*\(|\bnew\s+Function\s*\(/)
    }
  })
})

describe('MDX importing and title extraction', () => {
  it('imports .mdx files losslessly while extracting titles from front matter, ESM exports, headings, or file names', () => {
    const fromYaml = mdx.convertImport('mdx', {
      name: 'intro.mdx',
      text: '\ufeff---\r\ntitle: "Getting Started"\r\ntags: [docs, mdx]\r\n---\r\n\r\n# Heading\r\n\r\n<Callout>Hi</Callout>\r\n',
    })
    expect(checkResult('import.convert', fromYaml)).toEqual({
      title: 'Getting Started',
      markdown:
        '---\ntitle: "Getting Started"\ntags: [docs, mdx]\n---\n\n# Heading\n\n<Callout>Hi</Callout>\n',
    })

    const fromMetadataExport = mdx.convertImport('mdx', {
      name: 'route.mdx',
      text: "export const metadata = {\n  title: 'Next MDX Guide',\n  draft: false,\n}\n\nBody text.\n",
    })
    expect(fromMetadataExport.title).toBe('Next MDX Guide')

    const fromHeadingWithExpr = mdx.convertImport('mdx', {
      name: 'release.mdx',
      text: "export const version = '3.1'\n\n# Release **v{version}** Notes\n\nDetails.\n",
    })
    expect(fromHeadingWithExpr.title).toBe('Release v3.1 Notes')

    const fromCjkFile = mdx.convertImport('mdx', {
      name: '\u6587\u6863\u6307\u5357.mdx',
      text: '<Callout type="info">Body without heading</Callout>',
    })
    expect(fromCjkFile.title).toBe('\u6587\u6863\u6307\u5357')

    const emptyFile = mdx.convertImport('mdx', { name: 'empty-note.mdx', text: '' })
    expect(emptyFile.title).toBe('empty-note')
    expect(checkResult('import.convert', emptyFile).title).toBe('empty-note')
  })

  it('imports .mdx as compiled Devot Markdown when mdx-markdown format is chosen', () => {
    const source = [
      '---',
      'title: Quickstart',
      '---',
      '',
      "import { Callout } from '@/components/ui'",
      "export const pkg = 'devot-mdx'",
      '',
      '{/* Internal author comment */}',
      '',
      'Install `{pkg}`? Run **{pkg}** now:',
      '',
      '<Callout type="tip" title="Fast Setup">',
      '  Works offline in **30 seconds**.',
      '</Callout>',
    ].join('\n')

    const converted = mdx.convertImport('mdx-markdown', { name: 'quickstart.mdx', text: source })
    expect(converted.title).toBe('Quickstart')
    expect(converted.markdown).toContain('---\ntitle: Quickstart\n---')
    expect(converted.markdown).not.toContain('import { Callout }')
    expect(converted.markdown).not.toContain('Internal author comment')
    expect(converted.markdown).toContain('Run **devot-mdx** now:')
    expect(converted.markdown).toContain('> [!TIP]')
    expect(converted.markdown).toContain('**Fast Setup**')
    expect(converted.markdown).toContain('Works offline in **30 seconds**.')
  })
})

describe('CSP-safe expression and local component evaluation', () => {
  it('evaluates literals, templates, operators, ternaries, and safe array/string helpers', () => {
    const scope = {
      version: '2.4.0',
      count: 3,
      items: ['alpha', 'beta', 'gamma'],
      meta: { plan: 'pro', seats: 5 },
    }
    expect(mdx.evaluateExpression('1 + 2 * 4', scope)).toEqual({ ok: true, value: 9 })
    expect(mdx.evaluateExpression('`v${version} (${meta.plan.toUpperCase()})`', scope)).toEqual({
      ok: true,
      value: 'v2.4.0 (PRO)',
    })
    expect(mdx.evaluateExpression("count > 1 ? `${count} items` : '1 item'", scope)).toEqual({
      ok: true,
      value: '3 items',
    })
    expect(mdx.evaluateExpression('items.filter(x => x.length > 4).join(", ")', scope)).toEqual({
      ok: true,
      value: 'alpha, gamma',
    })
    expect(mdx.evaluateExpression('missing?.deep ?? "fallback"', scope)).toEqual({
      ok: true,
      value: 'fallback',
    })
  })

  it('refuses prototype escapes and global realm access', () => {
    for (const attempt of [
      '({}).constructor',
      '(() => {}).constructor("return 1")()',
      '__proto__',
      'Object.prototype',
      'window',
      'document',
      'globalThis',
    ]) {
      const res = mdx.evaluateExpression(attempt, {})
      expect(res.ok ? res.value : undefined).toBeUndefined()
    }
  })

  it('evaluates local exported JSX components with props and children', () => {
    const doc = [
      'export const StatusPill = ({ label, active = true }) => <Badge variant={active ? "tip" : "note"}>{label}</Badge>',
      'export const SelfClosingChip = () => <Kbd>Esc</Kbd>',
      '',
      'export function FeatureSection({ heading, children }) {',
      '  return (',
      '    <Callout type="important" title={heading}>',
      '      {children}',
      '    </Callout>',
      '  )',
      '}',
      '',
      'Status: <StatusPill label="Ready" /> <SelfClosingChip />',
      '',
      '<FeatureSection heading="Offline Sync">',
      '  Encrypted end to end.',
      '</FeatureSection>',
    ].join('\n')

    const compiled = mdx.compileMdxToMarkdown(doc)
    expect(compiled).toContain('Ready')
    expect(compiled).toContain('<kbd>Esc</kbd>')
    expect(compiled).toContain('> [!IMPORTANT]')
    expect(compiled).toContain('**Offline Sync**')
    expect(compiled).toContain('Encrypted end to end.')
  })

  it('expands dynamic .map() JSX children inside Steps, Tabs, Cards, and bounds runaway recursion', () => {
    const dynamicDoc = [
      "export const steps = ['Install', 'Verify']",
      '',
      '<Steps>',
      '  {steps.map((s) => (',
      '    <Step title={s}>Run {s.toLowerCase()} check.</Step>',
      '  ))}',
      '</Steps>',
      '',
      '<CodeGroup>',
      '  ```sh title="pnpm"',
      '  pnpm add mdx',
      '  ```',
      '  ```sh title="npm"',
      '  npm i mdx',
      '  ```',
      '</CodeGroup>',
      '',
      '<ParamField path="noteId" type="string" required>',
      '  Unique UUIDv7 identifier.',
      '</ParamField>',
      '',
      '<Stat label="Latency" value="8 ms" />',
      '<Math formula="E = mc^2" />',
      '<Mermaid chart="graph LR; A-->B;" />',
    ].join('\n')

    const md = mdx.compileMdxToMarkdown(dynamicDoc)
    expect(md).toContain('1. **Install**')
    expect(md).toContain('2. **Verify**')
    expect(md).toContain('**`noteId`** `string` *(required)*')
    expect(md).toContain('**Latency:** `8 ms`')
    expect(md).toContain('$E = mc^2$')
    expect(md).toContain('```mermaid\ngraph LR; A-->B;\n```')

    const studio = mdx.renderStudioHtml(dynamicDoc)
    expect(studio.previewHtml).toContain('data-mdx-component="steps"')
    expect(studio.previewHtml).toContain('data-mdx-component="code-group"')
    expect(studio.previewHtml).toContain('pnpm')
    expect(studio.previewHtml).toContain('8 ms')

    const runaway = 'export const loop = (n) => loop(n + 1)\n\n{loop(0)}'
    const report = mdx.inspectMdx(runaway)
    expect(report.diagnostics.some((d) => d.code === 'MDX_INVALID_EXPRESSION')).toBe(true)
  })
})

describe('MDX component rendering through Devot preview pipeline', () => {
  const renderInDevot = async (noteMarkdown: string) => {
    const specs = [
      { key: 'community.mdx/mdx', language: 'mdx', output: 'markdown' as const },
      { key: 'community.mdx/mdx-code', language: 'mdx-code', output: 'markdown' as const },
    ]
    const tree = await renderPreview(
      noteMarkdown,
      { labels, loadedEmbeds: [] },
      createPreviewRegistry({
        builtins: true,
        plugins: {
          specs,
          render: async (key, source) =>
            mdx.renderPreviewBlock(source, key.endsWith('/mdx-code') ? 'mdx-code' : 'mdx'),
        },
      }),
    )
    return toHtml(tree)
  }

  it('renders Callouts, Tabs, Steps, Cards, Accordions, FileTree, Kbd, Badges, and dynamic lists', async () => {
    const block = [
      '```mdx',
      '---',
      'title: Component Showcase',
      'status: active',
      '---',
      '',
      "import { Callout, Tabs, Tab, Steps, Step, Cards, Card } from 'fumadocs-ui'",
      "export const tools = ['CLI', 'MCP']",
      '',
      '<Callout type="warning" title="Watch Out">',
      '  Press <Kbd>Cmd+K</Kbd> to open the palette.',
      '</Callout>',
      '',
      '<Tabs items={["pnpm", "npm"]} defaultIndex={0}>',
      '  <Tab value="pnpm">Run `pnpm install`.</Tab>',
      '  <Tab value="npm">Run `npm install`.</Tab>',
      '</Tabs>',
      '',
      '<Steps>',
      '  <Step title="Write MDX">Author components cleanly.</Step>',
      '  <Step title="Preview">Check live output.</Step>',
      '</Steps>',
      '',
      '<Cards>',
      '  <Card title="Note Link" href="devot://note/0192a6f0-0000-7000-8000-000000000009">',
      '    Jump to linked note.',
      '  </Card>',
      '  <Card title="External Docs" href="https://mdxjs.com/docs">',
      '    Reference manual.',
      '  </Card>',
      '</Cards>',
      '',
      '<Accordion title="More Details" defaultOpen>',
      '  Supported tools: {tools.join(" + ")}.',
      '</Accordion>',
      '',
      '<FileTree>',
      '  <FileTree.Folder name="plugins" defaultOpen>',
      '    <FileTree.File name="main.js" active />',
      '  </FileTree.Folder>',
      '</FileTree>',
      '',
      '<PricingMatrix tier="pro" seats={10}>',
      '  Custom unknown component body.',
      '</PricingMatrix>',
      '```',
    ].join('\n')

    const html = await renderInDevot(block)
    expect(html).toContain('class="plugin-block"')
    expect(html).toContain('alert alert-warning')
    expect(html).toContain('Watch Out')
    expect(html).toContain('<kbd>Cmd+K</kbd>')
    expect(html).toContain('<details open>')
    expect(html).toContain('pnpm install')
    expect(html).toContain('Write MDX')
    expect(html).toContain('devot://note/0192a6f0-0000-7000-8000-000000000009')
    expect(html).toContain('Supported tools: CLI + MCP.')
    expect(html).toContain('plugins')
    expect(html).toContain('main.js')
    expect(html).toContain('PricingMatrix')
    expect(html).toContain('tier')
    expect(html).toContain('Custom unknown component body.')
  })

  it('highlights MDX source in mdx-code blocks and supports // @both playground mode', async () => {
    const codeHtml = await renderInDevot(
      '```mdx-code\nimport { Badge } from "./ui"\n\n# Heading\n\n<Badge>v1</Badge>\n```',
    )
    expect(codeHtml).toContain('class="code-block"')
    expect(codeHtml).toContain('hljs-keyword')
    expect(codeHtml).toContain('Badge')

    const bothHtml = await renderInDevot(
      '```mdx\n// @both\nexport const n = 7\n\n<Callout type="tip">Value is {n}</Callout>\n```',
    )
    expect(bothHtml).toContain('class="code-block"')
    expect(bothHtml).toContain('alert alert-tip')
    expect(bothHtml).toContain('Value is 7')
  })

  it('preserves JSX and braces inside fenced code blocks and inline code spans untouched', () => {
    const md = mdx.compileMdxToMarkdown(
      [
        'Inline `<Callout>{untouched}</Callout>` stays code.',
        '',
        '```tsx',
        'export const untouched = <Callout>{raw}</Callout>',
        '```',
      ].join('\n'),
    )
    expect(md).toContain('`<Callout>{untouched}</Callout>`')
    expect(md).toContain('export const untouched = <Callout>{raw}</Callout>')
  })
})

describe('MDX syntax highlighting, Studio rendering, and diagnostics', () => {
  it('tokenizes all MDX layers: YAML front matter, ESM, Markdown, JSX components, expressions, and comments', () => {
    const sample = [
      '---',
      'title: Highlighting',
      '---',
      "import { Callout } from './callout'",
      'export const count = 42',
      '',
      '{/* MDX comment */}',
      '# Heading **bold** `code`',
      '<Callout type="tip" count={count}>',
      '  Hello <span className="muted">{count + 1}</span>',
      '</Callout>',
    ].join('\n')

    const highlighted = mdx.highlightMdx(sample)
    expect(highlighted.lineCount).toBe(11)
    const types = new Set(highlighted.tokens.map((t) => t.type))
    expect(types.has('frontmatter-fence')).toBe(true)
    expect(types.has('frontmatter-key')).toBe(true)
    expect(types.has('esm-keyword')).toBe(true)
    expect(types.has('comment')).toBe(true)
    expect(types.has('md-heading')).toBe(true)
    expect(types.has('jsx-component')).toBe(true)
    expect(types.has('jsx-html-tag')).toBe(true)
    expect(types.has('jsx-attr')).toBe(true)
    expect(types.has('expr-brace')).toBe(true)
    expect(highlighted.html).not.toContain('<Callout')
    expect(highlighted.html).toContain('&lt;')
  })

  it('detects unclosed JSX tags, mismatched tags, HTML comments, unclosed void tags, and unclosed braces', () => {
    const broken = [
      '<!-- legacy html comment -->',
      'Latency is <10ms on average.',
      'Line break <br> here.',
      '<Callout type="note">',
      '  <Badge>Open',
      '</Callout>',
      'Broken {1 + ',
    ].join('\n')

    const report = mdx.inspectMdx(broken)
    const codes = report.diagnostics.map((d) => d.code)
    expect(codes).toContain('MDX_HTML_COMMENT')
    expect(codes).toContain('MDX_BARE_LESS_THAN')
    expect(codes).toContain('MDX_UNCLOSED_VOID_TAG')
    expect(codes).toContain('MDX_MISMATCHED_TAG')
    expect(codes).toContain('MDX_UNCLOSED_EXPRESSION')
  })

  it('produces safe Studio HTML with zero frames, scripts, inline styles, or event handlers', () => {
    const hostile = [
      '<script>window.pwn = 1</script>',
      '<iframe src="https://evil.example"></iframe>',
      '<object data="x"></object>',
      '<embed src="x" />',
      '<link rel="preconnect" href="https://evil.example" />',
      '<img src="x" onerror="alert(1)" />',
      '<a href="javascript:alert(2)">bad link</a>',
      '<Callout type="tip" title="Safe">Clean **content**</Callout>',
    ].join('\n')

    const studio = mdx.renderStudioHtml(hostile)
    expect(studio.previewHtml).not.toMatch(
      /<script|<iframe|<frame|<object|<embed|<portal|<fencedframe|<link\b|onerror|javascript:|style=/i,
    )
    expect(studio.previewHtml).toContain('Safe')
    expect(studio.previewHtml).toContain('<strong>content</strong>')
  })
})

describe('Bidirectional Markdown <-> MDX conversion, preview toggle, and export', () => {
  it('converts Devot Markdown idioms to valid MDX v3 without touching code blocks', () => {
    const md = [
      '---',
      'title: Migration',
      '---',
      '',
      '<!-- Convert this comment -->',
      '',
      '> [!WARNING]',
      '> Latency must stay <10ms.<br>',
      '> <div class="box" for="id">Check <img src="a.png"></div>',
      '',
      '```html',
      '<!-- Keep inside fence --> <br> <div class="raw">',
      '```',
    ].join('\n')

    const converted = mdx.convertMarkdownToMdx(md)
    expect(converted).toContain('{/* Convert this comment */}')
    expect(converted).toContain('<Callout type="warning">')
    expect(converted).toContain('&lt;10ms.')
    expect(converted).toContain('<br />')
    expect(converted).toContain('className="box"')
    expect(converted).toContain('htmlFor="id"')
    expect(converted).toContain('<img src="a.png" />')
    expect(converted).toContain('<!-- Keep inside fence --> <br> <div class="raw">')
    expect(mdx.inspectMdx(converted).diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  })

  it('toggles an MDX preview fence around the body while keeping YAML front matter at the top', () => {
    const raw = [
      '---',
      'title: Live Split',
      '---',
      '',
      '<Callout type="tip">',
      '  ```ts',
      '  const x = 1',
      '  ```',
      '</Callout>',
    ].join('\n')

    const wrapped = mdx.togglePreviewBlock(raw)
    expect(wrapped.wrapped).toBe(true)
    expect(wrapped.markdown.startsWith('---\ntitle: Live Split\n---\n\n````mdx\n')).toBe(true)

    const unwrapped = mdx.togglePreviewBlock(wrapped.markdown)
    expect(unwrapped.wrapped).toBe(false)
    expect(unwrapped.markdown).toBe(raw)

    const exported = mdx.convertExport('mdx', { title: 'Live Split', markdown: wrapped.markdown })
    expect(exported).toBe(`${raw}\n`)
  })

  it('adds title front matter on export when the note has no matching H1 or front matter title', () => {
    const exported = mdx.convertExport('mdx', {
      title: 'Standalone Component',
      markdown: '<Callout type="info">Body</Callout>\n',
    })
    expect(exported).toBe(
      '---\ntitle: Standalone Component\n---\n\n<Callout type="info">Body</Callout>\n',
    )
    expect(checkResult('export.convert', exported)).toBe(exported)
  })

  it('never throws or hangs on arbitrary fuzzed MDX-like strings', () => {
    const arb = fc.string({
      unit: fc.constantFrom(
        '<',
        '>',
        '/',
        '{',
        '}',
        '"',
        "'",
        '`',
        '\n',
        '-',
        '#',
        '*',
        '!',
        'a',
        'B',
        '1',
        ' ',
        '=',
      ),
      maxLength: 300,
    })
    for (const tricky of ['# ', '###   ', '- ', '1. ', '> ', "# {\n'<<B#", '<>', '</>', '{/*']) {
      expect(typeof mdx.compileMdxToMarkdown(tricky)).toBe('string')
      expect(typeof mdx.highlightMdx(tricky).html).toBe('string')
      expect(Array.isArray(mdx.inspectMdx(tricky).diagnostics)).toBe(true)
      expect(typeof mdx.renderStudioHtml(tricky).previewHtml).toBe('string')
    }
    fc.assert(
      fc.property(arb, (input) => {
        expect(typeof mdx.compileMdxToMarkdown(input)).toBe('string')
        expect(typeof mdx.highlightMdx(input).html).toBe('string')
        expect(Array.isArray(mdx.inspectMdx(input).diagnostics)).toBe(true)
        expect(typeof mdx.renderStudioHtml(input).previewHtml).toBe('string')
      }),
      { numRuns: 1000 },
    )
  })

  it('persists imported MDX notes and applies plugin edits cleanly on real SQLite', async () => {
    const storage = openSqliteAdapter(join(tempDir('devot-mdx-sqlite-'), 'devot.sqlite'))
    try {
      const notes = createNoteService({
        storage,
        clock: createClock('mac1'),
        newId: createIdGenerator(),
      })
      const converted = mdx.convertImport('mdx', {
        name: 'guide.mdx',
        text: '---\ntitle: SQLite MDX\n---\n\nexport const v = 4\n\n<Callout type="tip">Version {v}</Callout>\n',
      })
      const noteId = await captureNote(notes, { ...converted, bookId: null })
      const stored = await notes.read(noteId)
      expect(stored.title).toBe('SQLite MDX')
      expect(stored.bodyMd).toContain('<Callout type="tip">Version {v}</Callout>')

      const fm = mdx.parseFrontMatter(stored.bodyMd)
      const compiledBody = mdx.compileMdxToMarkdown(stored.bodyMd)
      const nextMd = `---\n${fm.yaml}\n---\n\n${compiledBody}\n`
      await notes.applyPluginEdit(noteId, { base: stored.bodyMd, markdown: nextMd })
      await notes.flush()

      const updated = (await storage.getNote(noteId))!
      expect(updated.bodyMd).toContain('> [!TIP]')
      expect(updated.bodyMd).toContain('Version 4')
    } finally {
      storage.close()
    }
  })
})
