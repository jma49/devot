// The marks of programming languages that code block headers show
// (design/icons/languages.json), and the fence names that pick each one.
import languagesJson from '../../../../design/icons/languages.json'

export type LanguageMark = keyof typeof languagesJson.icons

/** Fence names that differ from the mark's own name. */
const ALIASES: Readonly<Record<string, LanguageMark>> = {
  js: 'javascript',
  jsx: 'react',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  tsx: 'react',
  py: 'python',
  python3: 'python',
  rs: 'rust',
  golang: 'go',
  html: 'html5',
  htm: 'html5',
  xhtml: 'html5',
  scss: 'css',
  less: 'css',
  jsonc: 'json',
  json5: 'json',
  md: 'markdown',
  bash: 'gnubash',
  sh: 'gnubash',
  shell: 'gnubash',
  zsh: 'gnubash',
  console: 'gnubash',
  java: 'openjdk',
  h: 'c',
  'c++': 'cplusplus',
  cpp: 'cplusplus',
  cc: 'cplusplus',
  cxx: 'cplusplus',
  hpp: 'cplusplus',
  'c#': 'dotnet',
  cs: 'dotnet',
  csharp: 'dotnet',
  fsharp: 'dotnet',
  rb: 'ruby',
  kt: 'kotlin',
  kts: 'kotlin',
  yml: 'yaml',
  dockerfile: 'docker',
  vue: 'vuedotjs',
  hs: 'haskell',
  ex: 'elixir',
  exs: 'elixir',
  pl: 'perl',
  gql: 'graphql',
  tex: 'latex',
}

/** The mark for a fence's language name, if Devot has one. */
export function languageMark(language: string): LanguageMark | undefined {
  const name = language.toLowerCase()
  if (Object.hasOwn(ALIASES, name)) return ALIASES[name]
  return Object.hasOwn(languagesJson.icons, name) ? (name as LanguageMark) : undefined
}

/** A mark's SVG path, on a 24 by 24 grid. */
export function markPath(mark: LanguageMark): string {
  return languagesJson.icons[mark]
}

/**
 * A code block's language (its `language-*` class) and title (`data-title`),
 * as the note wrote them; empty when it has neither.
 */
export function codeLabel(code: Element | null): { language: string; title: string } {
  const language =
    Array.from(code?.classList ?? [])
      .find((c) => c.startsWith('language-'))
      ?.slice('language-'.length) ?? ''
  return { language, title: code?.getAttribute('data-title') ?? '' }
}
