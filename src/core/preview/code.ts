// Code blocks: a header with the block's language (name and mark) and an
// optional title, and syntax highlighting. The fence's info string comes from
// the note's Markdown at the block's position: ```js, ```js:app.js and
// ```js title="app.js". A fence can also name its source and number its lines:
// ```ts line=10-20 commit=a1b2c3d url=https://github.com/o/r/blob/a1b2c3d/a.ts.
// The highlighter loads only for notes that need it, and then loads only the
// grammars their code blocks use.
import type { Element, ElementContent, Root, RootContent } from 'hast'
import languageIcons from '../../../design/icons/languages.json'
import {
  httpsUrl,
  parseLineRange,
  tokenizeFenceInfo,
  withoutHash,
  type LineRange,
} from '../codeMeta'
import { fillPlaceholders } from '../text'
import { PREVIEW_API_VERSION, type PreviewRenderer } from './registry'

export interface CodeInfo {
  /** The language, lowercased and checked, or null. */
  language: string | null
  /** The block's title (a file name, say), or null. */
  title: string | null
  /** `filename=`: the text of the source link, or null. */
  filename: string | null
  /** `line=5` or `line=5-9`: the number of the block's first line, or null. */
  line: LineRange | null
  /** `url=`: where the code comes from; https only, or null. */
  url: string | null
  /** `branch=`, or null. */
  branch: string | null
  /** `commit=`, or null. */
  commit: string | null
}

const LANGUAGE = /^[a-z0-9_+#.-]{1,32}$/
const REF = /^[\w./-]{1,100}$/
const MAX_TITLE = 200

/** Reads a fence's info string: `js`, `js:app.js` or `js title="app.js" line=5`. */
export function parseCodeInfo(info: string): CodeInfo {
  const { head, meta } = tokenizeFenceInfo(info)
  const colon = head.indexOf(':')
  const lang = (colon < 0 ? head : head.slice(0, colon)).toLowerCase()
  const short = (value: string | undefined) => value?.trim().slice(0, MAX_TITLE) || null
  const filename = short(meta.get('filename'))
  const title =
    short(colon < 0 ? '' : head.slice(colon + 1)) ??
    short(meta.get('title')) ??
    short(meta.get('file')) ??
    filename
  const ref = (key: string) => {
    const value = meta.get(key)
    return value !== undefined && REF.test(value) ? value : null
  }
  const url = meta.get('url')
  const line = meta.get('line')
  return {
    language: LANGUAGE.test(lang) ? lang : null,
    title,
    filename,
    line: line === undefined ? null : parseLineRange(line),
    url: url === undefined ? null : httpsUrl(url),
    branch: ref('branch'),
    commit: ref('commit'),
  }
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

/** Highlights code as a language; null when there is no such grammar. */
export type Highlighter = (grammar: string, code: string) => Promise<ElementContent[] | null>

export async function loadHighlighter(): Promise<Highlighter> {
  const { highlight } = await import('./highlight')
  return highlight
}

/** Longer blocks show as plain text: highlighting runs on every keystroke. */
const MAX_HIGHLIGHT = 20_000
const MAX_NUMBERED_LINES = 100_000

const FENCE = /^(`{3,}|~{3,})([^\n]*)/

const el = (tagName: string, properties: Element['properties'], children: ElementContent[] = []) =>
  ({ type: 'element', tagName, properties, children }) as Element

function textOf(node: RootContent | Root): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(textOf).join('') : ''
}

/** The mark for a language or the GitHub mark; a generic one (two angle brackets) else. */
function icon(mark: string | undefined): Element {
  const own = mark ? languageIcons.icons[mark as keyof typeof languageIcons.icons] : undefined
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

const GITHUB = 'https://github.com/'
const txt = (value: string): ElementContent => ({ type: 'text', value })

/** The line count of code that ends in a line break: that last break starts no line. */
function lineCount(text: string): number {
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

/** The link text for a source: its file name, else its URL without GitHub's origin and hash. */
function sourceText(info: CodeInfo): string {
  if (info.filename) return info.filename
  const url = withoutHash(info.url ?? '')
  return url.startsWith(GITHUB) ? url.slice(GITHUB.length) : url
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
      const info = parseCodeInfo(fence?.[2] ?? '')
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
    async transform(tree, { source, labels }) {
      const blocks: [Root | Element, Block][] = []
      collect(tree, source, blocks)
      const needs = blocks.some(([, b]) => b.info.language)
      const highlight = needs ? await (highlighter ??= load()) : null
      for (const [parent, { pre, code, info }] of blocks) {
        const lang = info.language ? codeLanguage(info.language) : null
        const text = textOf(code)
        if (info.language && highlight && text.length <= MAX_HIGHLIGHT) {
          const out = await highlight(lang?.grammar ?? info.language, text)
          if (out) code.children = out
        }
        code.properties['className'] = info.language ? [`language-${info.language}`] : []
        if (info.line && lineCount(text) <= MAX_NUMBERED_LINES) {
          const first = info.line.start
          const numbers = Array.from({ length: lineCount(text) }, (_, i) => String(first + i))
          pre.children = [
            el('span', { className: ['code-gutter'], ariaHidden: 'true' }, [
              txt(numbers.join('\n')),
            ]),
            code,
          ]
          pre.properties['className'] = ['with-line-numbers']
        }
        const sourced = info.url || info.branch || info.commit || info.line
        if (!lang && !info.title && !sourced) continue
        const label: ElementContent[] = []
        const linkText = info.url ? sourceText(info) : ''
        if (info.title && info.title !== linkText) {
          label.push(el('span', { className: ['code-title'] }, [txt(info.title)]))
        }
        if (info.url) {
          label.push(
            el(
              'a',
              {
                className: ['code-source'],
                href: withoutHash(info.url),
                title: labels.codeSource,
                ariaLabel: `${labels.codeSource}: ${linkText}`,
              },
              [txt(linkText)],
            ),
          )
        }
        if (info.line) {
          const { start, end } = info.line
          const value =
            end === null
              ? fillPlaceholders(labels.codeLine, { n: String(start) })
              : fillPlaceholders(labels.codeLines, { start: String(start), end: String(end) })
          label.push(el('span', { className: ['code-lines-label'] }, [txt(value)]))
        }
        const ref = info.commit ?? info.branch
        if (ref) {
          label.push(
            el(
              'span',
              { className: ['code-ref', info.commit ? 'code-ref-commit' : 'code-ref-branch'] },
              [txt(fillPlaceholders(labels.codeRef, { ref }))],
            ),
          )
        }
        if (lang) label.push(el('span', { className: ['code-lang'] }, [txt(lang.name)]))
        const mark = info.url?.startsWith(GITHUB) ? 'github' : lang?.icon
        const block = el(
          'div',
          { className: ['code-block'], dataLanguage: info.language ?? undefined },
          [
            el('div', { className: ['code-header', ...(sourced ? ['code-header-source'] : [])] }, [
              icon(mark),
              ...label,
            ]),
            pre,
          ],
        )
        if (pre.position) block.position = pre.position
        const at = parent.children.indexOf(pre)
        parent.children[at] = block
      }
    },
  }
}
