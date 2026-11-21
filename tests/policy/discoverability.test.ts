import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'

// GitHub, package.json and llms.txt must quote the same line.
const ONE_LINER =
  'Local-first Markdown notes for Mac and iPhone: live preview, end-to-end encrypted sync, plugins, themes and MCP for AI tools.'

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  description: string
  homepage: string
}
const readme = readFileSync('README.md', 'utf8')
const llms = readFileSync('llms.txt', 'utf8')
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8')
const manifest = JSON.parse(readFileSync('docs/seo/submission-manifest.json', 'utf8')) as {
  product: { name: string; url: string; domain: string; contact_email: string | null }
  copy: {
    tagline_40c: string
    tagline_60c: string
    mcp_description_100c: string
    description_160c: string
    description_500c: string
    key_features: string[]
  }
  taxonomy: {
    competitors_replaced: string[]
    prices_recorded_in_repo: {
      mac_licence_website_usd: number
      app_store_devot_pro_usd: number
      source: string
    }
  }
  assets: { favicon_64: string | null; screenshots_in_repo: string[] }
  agent_and_mcp: { mcp_endpoint: string | null; github_repo: string }
  open_questions: string
}
const store = JSON.parse(readFileSync('docs/seo/store/app-store.en.json', 'utf8')) as {
  name: string
  subtitle: string
  keywords: string
  promotionalText: string
  description: string
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

const seoFiles = walk('docs/seo')
const prose = [llms, ...seoFiles.map((file) => readFileSync(file, 'utf8'))].join('\n')

it('shares one product line and the product site', () => {
  expect(pkg.description).toBe(ONE_LINER)
  expect(cargo).toContain(`description = "${ONE_LINER}"`)
  expect(pkg.homepage).toBe('https://devot.online')
  expect(readme).toContain(ONE_LINER)
  expect(readme).toContain('https://devot.online')
  expect(readme).toContain('iPad')
  expect(llms).toContain(ONE_LINER)
  expect(llms).toContain('https://devot.online/llms.txt')
  expect(llms).toContain('docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md')
})

it('keeps unconfirmed prices out of llms.txt and in the ADR record', () => {
  const adr = readFileSync(
    'docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md',
    'utf8',
  )
  expect(llms).toContain('https://devot.online/#pricing')
  expect(llms).not.toMatch(/US\$\d/)
  expect(adr).toContain('US$29.90')
  expect(adr).toContain('US$29.99')
  expect(readFileSync('docs/seo/kb/brand-ssot.md', 'utf8')).toContain('US$29.90')
  expect(manifest.taxonomy.prices_recorded_in_repo).toEqual({
    mac_licence_website_usd: 29.9,
    app_store_devot_pro_usd: 29.99,
    source: 'docs/adr/0014-iphone-sold-on-the-app-store-with-the-licence-kept.md',
  })
})

it('keeps directory copy inside the length limits', () => {
  expect(manifest.product.name).toBe('Devot')
  expect(manifest.product.url).toBe('https://devot.online')
  expect(manifest.product.domain).toBe('devot.online')
  expect(manifest.product.contact_email).toBeNull()
  expect(manifest.taxonomy.competitors_replaced).toEqual([])
  expect(manifest.agent_and_mcp.mcp_endpoint).toBeNull()
  expect(manifest.agent_and_mcp.github_repo).toBe('https://github.com/jma49/devot')
  expect(manifest.copy.tagline_40c.length).toBeLessThanOrEqual(40)
  expect(manifest.copy.tagline_60c.length).toBeLessThanOrEqual(60)
  expect(manifest.copy.mcp_description_100c.length).toBeLessThanOrEqual(100)
  expect(manifest.copy.description_160c.length).toBeLessThanOrEqual(160)
  expect(manifest.copy.description_500c.length).toBeLessThanOrEqual(500)
  expect(manifest.copy.key_features.length).toBeGreaterThanOrEqual(4)
  expect(manifest.open_questions).toBe('docs/seo/kb/open-questions.md')
  expect(readFileSync(manifest.open_questions, 'utf8')).toContain('TODO:')
  expect(existsSync(manifest.assets.favicon_64 ?? '')).toBe(true)
  for (const shot of manifest.assets.screenshots_in_repo) expect(existsSync(shot)).toBe(true)
})

it('keeps the App Store paste within Apple limits and off the website checkout', () => {
  const words = (value: string) =>
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  const used = new Set([...words(store.name), ...words(store.subtitle)])
  expect(store.name.length).toBeLessThanOrEqual(30)
  expect(store.subtitle.length).toBeLessThanOrEqual(30)
  expect(store.keywords.length).toBeLessThanOrEqual(100)
  expect(store.keywords).not.toMatch(/\s/)
  expect(store.promotionalText.length).toBeLessThanOrEqual(170)
  expect(store.description.length).toBeLessThanOrEqual(4000)
  expect(store.description).toContain('one-time')
  expect(store.description).toContain('iPad')
  expect(store.description).not.toMatch(/licen[cs]e key/i)
  const listing = `${store.keywords}\n${store.promotionalText}\n${store.description}`
  expect(listing).not.toMatch(/https?:|29\.90|licence\.devot\.online/)
  for (const keyword of store.keywords.split(',')) {
    expect(keyword.length).toBeGreaterThan(0)
    expect(used.has(keyword)).toBe(false)
  }
})

it('names Devot in every README image', () => {
  const alts = [...readme.matchAll(/<img\b[^>]*\balt="([^"]*)"/g)].map((match) => match[1] ?? '')
  expect(alts.length).toBeGreaterThan(0)
  for (const alt of alts) expect(alt.toLowerCase()).toContain('devot')
})

it('leaves private pages out of the index', () => {
  expect(readFileSync('licence/src/pages.ts', 'utf8')).toContain('noindex')
  expect(readFileSync('share/src/viewer.ts', 'utf8')).toContain('noindex, nofollow')
  expect(readFileSync('share/src/app.ts', 'utf8')).toContain('noindex, nofollow')
})

it('uses no em dashes or hype in the new discoverability copy', () => {
  expect(prose).not.toMatch(/\u2014|\u2013/)
  expect(prose).not.toMatch(/\b(unleash|revolutionize|seamless|game-changing)\b/i)
  expect(readFileSync('docs/seo/kb/open-questions.md', 'utf8')).toContain('TODO:')
  expect(readFileSync('docs/seo/kb/brand-ssot.md', 'utf8')).toContain('FSL-1.1-MIT')
})

it('links only files that exist from the discoverability notes', () => {
  const notes = seoFiles.filter((file) => file.endsWith('.md'))
  const missing = notes.flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)]
      .map((match) => match[1] ?? '')
      .filter((link) => !/^[a-z][\w+.-]*:/.test(link) && !link.startsWith('#'))
      .filter((link) => !existsSync(join(dirname(file), link.split('#')[0] ?? ''))),
  )
  expect(missing).toEqual([])
})
