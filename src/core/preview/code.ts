// Fenced code blocks with a title bar: the language's mark and the block's
// title (```ts title="example.ts"), or the language's name when there is no
// title. A block with neither stays a bare code block.
//
// The info string after the language reaches this renderer as `data-meta` on
// the `code` element (the Markdown-to-HTML step in index.ts sets it, the
// sanitizer's allowlist keeps it). Anything else in it is ignored, and a note
// can set the attribute in raw HTML too, so the title is only ever shown as
// text, cut to fit.
import type { Element, ElementContent, Properties, Root } from 'hast'
import { LANGUAGE_ICONS } from './languageIcons'
import { PREVIEW_API_VERSION, type PreviewRenderer } from './registry'

/** The longest title the bar shows. */
export const MAX_CODE_TITLE_CHARS = 120

/** Fence languages (lower case) and the mark that stands for each. */
const ALIASES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  console: 'shell',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  css: 'css',
  scss: 'css',
  go: 'go',
  golang: 'go',
  java: 'java',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  c: 'c',
  swift: 'swift',
  rb: 'ruby',
  ruby: 'ruby',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  php: 'php',
  kt: 'kotlin',
  kotlin: 'kotlin',
  docker: 'docker',
  dockerfile: 'docker',
  toml: 'toml',
  lua: 'lua',
}

/** What the bar calls a language it has a mark for (others show as written). */
const NAMES: Readonly<Record<string, string>> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  rust: 'Rust',
  shell: 'Shell',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  go: 'Go',
  java: 'Java',
  cpp: 'C++',
  c: 'C',
  swift: 'Swift',
  ruby: 'Ruby',
  sql: 'SQL',
  yaml: 'YAML',
  markdown: 'Markdown',
  php: 'PHP',
  kotlin: 'Kotlin',
  docker: 'Docker',
  toml: 'TOML',
  lua: 'Lua',
}

/** The `title` in a fence's info string: `title="a b"`, `title='a b'` or `title=ab`. */
export function codeTitle(meta: string): string | null {
  const match = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta)
  const title = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim()
  if (title === '') return null
  return title.length > MAX_CODE_TITLE_CHARS
    ? `${title.slice(0, MAX_CODE_TITLE_CHARS - 1)}…`
    : title
}

/** The mark for a fence language (the generic one for any other), and its name. */
export function codeLanguage(language: string): { icon: string; name: string } {
  const key = ALIASES[language.toLowerCase()]
  return key
    ? { icon: LANGUAGE_ICONS[key] ?? '', name: NAMES[key] ?? language }
    : { icon: LANGUAGE_ICONS['generic'] ?? '', name: language }
}

const el = (tagName: string, properties: Properties, children: ElementContent[] = []): Element => ({
  type: 'element',
  tagName,
  properties,
  children,
})

const LANGUAGE = /^language-(.+)$/

function visit(node: Root | Element): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    const classes = (child.properties['className'] as string[] | undefined) ?? []
    if (child.tagName !== 'pre' || classes.includes('frontmatter')) {
      visit(child)
      continue
    }
    const code = child.children.find((c): c is Element => c.type === 'element')
    if (code?.tagName !== 'code') continue
    const meta = code.properties['dataMeta']
    delete code.properties['dataMeta']
    const languages = (code.properties['className'] as string[] | undefined) ?? []
    const language = languages.map((c) => LANGUAGE.exec(c)?.[1]).find((l) => l !== undefined)
    const title = typeof meta === 'string' ? codeTitle(meta) : null
    if (language === undefined && title === null) continue
    const { icon, name } = codeLanguage(language ?? '')
    const label = title ?? name
    child.children.unshift(
      el('div', { className: ['code-head'] }, [
        ...(language === undefined
          ? []
          : [
              el('svg', { className: ['code-lang'], viewBox: '0 0 24 24', ariaHidden: 'true' }, [
                el('path', { d: icon }),
              ]),
            ]),
        el('span', { className: ['code-title'] }, [{ type: 'text', value: label }]),
      ]),
    )
  }
}

export const codeBlocks: PreviewRenderer = {
  id: 'devot.code',
  apiVersion: PREVIEW_API_VERSION,
  transform(tree) {
    visit(tree)
  },
}
