// Code blocks: a header with the block's language (name and mark) and an
// optional title, and syntax highlighting. The fence's info string comes from
// the note's Markdown at the block's position: ```js, ```js:app.js and
// ```js title="app.js". The highlighter loads only for notes that need it.
import type { Element, ElementContent, Root, RootContent } from 'hast'
import languageIcons from '../../../design/icons/languages.json'
import { PREVIEW_API_VERSION, type PreviewRenderer } from './registry'

export interface CodeInfo {
  /** The language, lowercased and checked, or null. */
  language: string | null
  /** The block's title (a file name, say), or null. */
  title: string | null
}

const LANGUAGE = /^[a-z0-9_+#.-]{1,32}$/
const MAX_TITLE = 200
const TITLE = /(?:^|\s)(?:title|filename|file)=(?:"([^"]*)"|'([^']*)'|(\S+))/i

/** Reads a fence's info string: `js`, `js:app.js` or `js title="app.js"`. */
export function parseCodeInfo(info: string): CodeInfo {
  const text = info.trim()
  const space = text.search(/\s/)
  const head = space < 0 ? text : text.slice(0, space)
  const meta = space < 0 ? '' : text.slice(space + 1)
  const colon = head.indexOf(':')
  const lang = (colon < 0 ? head : head.slice(0, colon)).toLowerCase()
  let title = colon < 0 ? '' : head.slice(colon + 1)
  if (!title) {
    const match = TITLE.exec(meta)
    title = match?.[1] ?? match?.[2] ?? match?.[3] ?? ''
  }
  title = title.trim().slice(0, MAX_TITLE)
  return { language: LANGUAGE.test(lang) ? lang : null, title: title || null }
}

interface Language {
  /** The name the header shows. */
  name: string
  /** The mark, a key of design/icons/languages.json. */
  icon?: keyof typeof languageIcons.icons
  /** The highlight.js grammar (highlight.ts). */
  grammar?: string
}

const LANGUAGES: readonly [string[], Language][] = [
  [
    ['js', 'javascript', 'mjs', 'cjs', 'node'],
    { name: 'JavaScript', icon: 'javascript', grammar: 'javascript' },
  ],
  [['jsx'], { name: 'JSX', icon: 'react', grammar: 'javascript' }],
  [
    ['ts', 'typescript', 'mts', 'cts'],
    { name: 'TypeScript', icon: 'typescript', grammar: 'typescript' },
  ],
  [['tsx'], { name: 'TSX', icon: 'react', grammar: 'typescript' }],
  [['py', 'python', 'python3'], { name: 'Python', icon: 'python', grammar: 'python' }],
  [['go', 'golang'], { name: 'Go', icon: 'go', grammar: 'go' }],
  [['swift'], { name: 'Swift', icon: 'swift', grammar: 'swift' }],
  [['kt', 'kts', 'kotlin'], { name: 'Kotlin', icon: 'kotlin', grammar: 'kotlin' }],
  [['c', 'h'], { name: 'C', icon: 'c', grammar: 'c' }],
  [['cpp', 'c++', 'cc', 'cxx', 'hpp'], { name: 'C++', icon: 'cplusplus', grammar: 'cpp' }],
  [['cs', 'csharp', 'c#'], { name: 'C#', grammar: 'csharp' }],
  [['java'], { name: 'Java', grammar: 'java' }],
  [['rs', 'rust'], { name: 'Rust', grammar: 'rust' }],
  [['rb', 'ruby'], { name: 'Ruby', grammar: 'ruby' }],
  [['php'], { name: 'PHP', grammar: 'php' }],
  [['html', 'htm', 'xhtml'], { name: 'HTML', icon: 'html5', grammar: 'xml' }],
  [['xml', 'svg', 'plist'], { name: 'XML', icon: 'xml', grammar: 'xml' }],
  [['vue'], { name: 'Vue', grammar: 'xml' }],
  [['svelte'], { name: 'Svelte', icon: 'svelte', grammar: 'xml' }],
  [['css'], { name: 'CSS', icon: 'css', grammar: 'css' }],
  [['scss'], { name: 'SCSS', icon: 'css', grammar: 'scss' }],
  [['json', 'jsonc', 'json5'], { name: 'JSON', icon: 'json', grammar: 'json' }],
  [['md', 'markdown'], { name: 'Markdown', icon: 'markdown', grammar: 'markdown' }],
  [['sh', 'bash', 'zsh', 'shell'], { name: 'Shell', icon: 'gnubash', grammar: 'bash' }],
  [['console', 'terminal'], { name: 'Console', icon: 'gnubash', grammar: 'shell' }],
  [['yaml', 'yml'], { name: 'YAML', icon: 'yaml', grammar: 'yaml' }],
  [['toml'], { name: 'TOML', icon: 'toml', grammar: 'ini' }],
  [['ini', 'conf', 'cfg'], { name: 'INI', grammar: 'ini' }],
  [['env', 'dotenv'], { name: '.env', icon: 'dotenv', grammar: 'bash' }],
  [['dockerfile', 'docker'], { name: 'Dockerfile', icon: 'docker', grammar: 'dockerfile' }],
  [['makefile', 'make', 'mk'], { name: 'Makefile', grammar: 'makefile' }],
  [['lua'], { name: 'Lua', icon: 'lua', grammar: 'lua' }],
  [['dart'], { name: 'Dart', icon: 'dart', grammar: 'dart' }],
  [['scala'], { name: 'Scala', icon: 'scala', grammar: 'scala' }],
  [['hs', 'haskell'], { name: 'Haskell', icon: 'haskell', grammar: 'haskell' }],
  [['ex', 'exs', 'elixir'], { name: 'Elixir', icon: 'elixir', grammar: 'elixir' }],
  [['erl', 'erlang'], { name: 'Erlang', icon: 'erlang', grammar: 'erlang' }],
  [['clj', 'cljs', 'clojure'], { name: 'Clojure', icon: 'clojure', grammar: 'clojure' }],
  [['jl', 'julia'], { name: 'Julia', icon: 'julia', grammar: 'julia' }],
  [['pl', 'perl'], { name: 'Perl', icon: 'perl', grammar: 'perl' }],
  [['r'], { name: 'R', grammar: 'r' }],
  [['graphql', 'gql'], { name: 'GraphQL', icon: 'graphql', grammar: 'graphql' }],
  [['sql'], { name: 'SQL', grammar: 'sql' }],
  [['diff', 'patch'], { name: 'Diff', grammar: 'diff' }],
]

const BY_ALIAS = new Map(LANGUAGES.flatMap(([aliases, lang]) => aliases.map((a) => [a, lang])))

/** What the header shows for `language`; an unknown one by its own name. */
export function codeLanguage(language: string): Language {
  return BY_ALIAS.get(language) ?? { name: language }
}

/** Highlights code as a grammar; null when it has no such grammar. */
export type Highlighter = (grammar: string, code: string) => ElementContent[] | null

export async function loadHighlighter(): Promise<Highlighter> {
  const { highlight } = await import('./highlight')
  return highlight
}

/** Longer blocks show as plain text: highlighting runs on every keystroke. */
const MAX_HIGHLIGHT = 20_000

const FENCE = /^(`{3,}|~{3,})([^\n]*)/

const el = (tagName: string, properties: Element['properties'], children: ElementContent[] = []) =>
  ({ type: 'element', tagName, properties, children }) as Element

function textOf(node: RootContent | Root): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textOf).join('') : ''
}

/** The mark for a language: its own, or a generic one (two angle brackets). */
function icon(lang: Language | null): Element {
  const own = lang?.icon ? languageIcons.icons[lang.icon] : undefined
  return el(
    'svg',
    {
      className: ['code-lang-icon', ...(own ? [] : ['code-lang-icon-generic'])],
      viewBox: '0 0 24 24',
      ariaHidden: 'true',
    },
    [el('path', { d: own ? own.path : 'M8 6 2 12l6 6M16 6l6 6-6 6' })],
  )
}

/** The class the language's code gets: from the fence, else the sanitized class. */
function classLanguage(code: Element): string | null {
  const names = (code.properties['className'] as string[] | undefined) ?? []
  const name = names.find((n) => n.startsWith('language-'))?.slice('language-'.length)
  return name ? parseCodeInfo(name).language : null
}

interface Block {
  pre: Element
  code: Element
  info: CodeInfo
}

/** The code blocks of `tree` (`pre` with one `code`), with their parents. */
function collect(node: Root | Element, source: string, out: [Root | Element, Block][]): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    if (child.tagName === 'pre') {
      const kids = child.children.filter((c) => !(c.type === 'text' && c.value.trim() === ''))
      const code = kids.length === 1 && kids[0]?.type === 'element' ? kids[0] : undefined
      if (!code || code.tagName !== 'code' || classOf(child).includes('frontmatter')) continue
      const offset = child.position?.start.offset
      const end = offset === undefined ? -1 : source.indexOf('\n', offset)
      const line = offset === undefined ? '' : source.slice(offset, end < 0 ? undefined : end)
      const fence = FENCE.exec(line)
      const info = fence ? parseCodeInfo(fence[2] ?? '') : { language: null, title: null }
      if (!info.language) info.language = classLanguage(code)
      out.push([node, { pre: child, code, info }])
      continue
    }
    collect(child, source, out)
  }
}

const classOf = (e: Element) => (e.properties['className'] as string[] | undefined) ?? []

export function createCodeRenderer(
  load: () => Promise<Highlighter> = loadHighlighter,
): PreviewRenderer {
  let highlighter: Promise<Highlighter> | null = null
  return {
    id: 'devot.code',
    apiVersion: PREVIEW_API_VERSION,
    async transform(tree, { source }) {
      const blocks: [Root | Element, Block][] = []
      collect(tree, source, blocks)
      const needs = blocks.some(([, b]) => b.info.language && codeLanguage(b.info.language).grammar)
      const highlight = needs ? await (highlighter ??= load()) : null
      for (const [parent, { pre, code, info }] of blocks) {
        const lang = info.language ? codeLanguage(info.language) : null
        if (lang?.grammar && highlight) {
          const text = textOf(code)
          const out = text.length <= MAX_HIGHLIGHT ? highlight(lang.grammar, text) : null
          if (out) code.children = out
        }
        code.properties['className'] = info.language ? [`language-${info.language}`] : []
        if (!lang && !info.title) continue
        const label: ElementContent[] = []
        if (info.title) {
          label.push(
            el('span', { className: ['code-title'] }, [{ type: 'text', value: info.title }]),
          )
        }
        if (lang)
          label.push(el('span', { className: ['code-lang'] }, [{ type: 'text', value: lang.name }]))
        const block = el(
          'div',
          { className: ['code-block'], dataLanguage: info.language ?? undefined },
          [el('div', { className: ['code-header'] }, [icon(lang), ...label]), pre],
        )
        if (pre.position) block.position = pre.position
        const at = parent.children.indexOf(pre)
        parent.children[at] = block
      }
    },
  }
}
