// Fixtures for `pnpm bench`: generated at bench time, never committed, and deterministic.
import * as Y from 'yjs'
/** The name of the note's text in its Yjs document (BODY in src/core/notes.ts). */
const BODY = 'body'

export const SAMPLE_END = 'End of the sample.'

export const SAMPLE_IMAGE = '/bench-images/'

export function diagramCount(bytes: number): number {
  return bytes >= 60_000 ? 8 : 3
}

const DIAGRAMS = [
  'flowchart LR\n  A[Capture] --> B{Sorted?}\n  B -->|yes| C[Notebook]\n  B -->|no| D[Inbox]\n  D --> B',
  'sequenceDiagram\n  participant U as Editor\n  participant W as Worker\n  U->>W: change\n  W-->>U: saved\n  U->>W: change',
  'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Review\n  Review --> Draft\n  Review --> Done\n  Done --> [*]',
  'pie title Notes by status\n  "Done" : 42\n  "Active" : 31\n  "Waiting" : 12',
]

const CODE: readonly { lang: string; code: string }[] = [
  {
    lang: 'ts',
    code: 'export function median(values: number[]): number {\n  const sorted = [...values].sort((a, b) => a - b)\n  return sorted[Math.floor(sorted.length / 2)] ?? 0\n}',
  },
  {
    lang: 'python',
    code: 'def fib(n: int) -> int:\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a',
  },
  {
    lang: 'rust',
    code: 'fn main() {\n    let notes: Vec<String> = (0..3).map(|i| format!("Note {i}")).collect();\n    println!("{notes:?}");\n}',
  },
  {
    lang: 'bash',
    code: '#!/bin/bash\nset -euo pipefail\nfor f in *.md; do\n  wc -c "$f"\ndone',
  },
  { lang: 'json', code: '{\n  "name": "devot",\n  "tags": ["a", "b"],\n  "pinned": false\n}' },
  { lang: 'css', code: '.note {\n  display: grid;\n  gap: 8px;\n  color: var(--text);\n}' },
  {
    lang: 'html',
    code: '<section class="note">\n  <h1>Title</h1>\n  <p>Body text</p>\n</section>',
  },
  {
    lang: 'sql',
    code: 'SELECT id, title\nFROM notes\nWHERE deleted_at IS NULL\nORDER BY updated_at DESC\nLIMIT 50;',
  },
  {
    lang: 'go',
    code: 'func Sum(xs []int) int {\n\ttotal := 0\n\tfor _, x := range xs {\n\t\ttotal += x\n\t}\n\treturn total\n}',
  },
  {
    lang: 'yaml',
    code: 'name: build\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest',
  },
  {
    lang: 'swift',
    code: 'struct Note: Identifiable {\n    let id: UUID\n    var title: String\n}',
  },
]

function section(n: number, diagram: string | null, image: boolean): string {
  const code = CODE[n % CODE.length]!
  const other = CODE[(n + 5) % CODE.length]!
  const parts = [
    `## Section ${n}: planning the week`,
    `Notes about **bold claims**, *emphasis*, ~~strikethrough~~, \`inline code\` and a [link](https://example.com/${n}). Paragraph ${n} goes on for a while so that lines wrap in the editor and the preview: the quick brown fox jumps over the lazy dog, and the dog does not mind at all.`,
    `- First point of section ${n}\n- Second point\n  - A nested point\n  - Another nested point\n- Third point`,
    '1. Step one\n2. Step two\n3. Step three',
    `- [x] Done task ${n}\n- [ ] Open task\n- [ ] Another open task`,
    `> A quotation from section ${n}, long enough to wrap onto a second line when the pane is narrow.`,
    `> [!NOTE]\n> An alert in section ${n}.`,
    '| Name | Count | Share |\n| --- | ---: | :---: |\n| Alpha | 12 | 40% |\n| Beta | 7 | 23% |\n| Gamma | 11 | 37% |',
    `\`\`\`${code.lang}\n${code.code}\n\`\`\``,
    'Inline math $e^{i\\pi} + 1 = 0$ and a block:\n\n$$\n\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}\n$$',
    `\`\`\`${other.lang} title="example-${n}"\n${other.code}\n\`\`\``,
  ]
  if (diagram) parts.push(`\`\`\`mermaid\n${diagram}\n\`\`\``)
  if (image) parts.push(`![Figure ${n}](${SAMPLE_IMAGE}${n}.svg)`)
  parts.push('---')
  return parts.join('\n\n')
}

/** Sections with every block type, repeated to about `bytes`, ending with SAMPLE_END. */
export function sampleNote(bytes: number): string {
  const diagrams = diagramCount(bytes)
  const unit = section(1, null, false).length + 2
  const sections = Math.max(diagrams, Math.ceil(bytes / unit))
  const gap = Math.floor(sections / diagrams)
  const out = ['# Benchmark sample', 'A generated note for measuring the editor and the preview.']
  let placed = 0
  for (let n = 1; n <= sections; n += 1) {
    const diagram =
      placed < diagrams && (n - 1) % gap === 0 ? DIAGRAMS[placed % DIAGRAMS.length]! : null
    if (diagram) placed += 1
    out.push(section(n, diagram, n % 4 === 0))
  }
  out.push(SAMPLE_END)
  return out.join('\n\n')
}

export function libraryBooks(notes: number): { id: string; name: string }[] {
  const count = notes >= 10_000 ? 50 : 12
  return Array.from({ length: count }, (_, i) => ({
    id: `0192a6f0-0000-7000-9000-${String(i + 1).padStart(12, '0')}`,
    name:
      i === 0
        ? 'Big notebook'
        : `Notebook ${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`,
  }))
}

/** The notebook index of library note `i`: a tenth unfiled, half in the big one, the rest spread. */
export function bookOf(i: number, books: number): number | null {
  if (i % 10 === 0) return null
  return i % 2 === 1 ? 0 : 1 + (i % (books - 1))
}

const WORDS = 'meeting plan review draft budget travel recipe idea reading project garden'.split(
  ' ',
)

export function libraryBody(i: number): string {
  const w = (k: number) => WORDS[(i * 7 + k * 3) % WORDS.length]!
  return `A ${w(0)} ${w(1)} about the ${w(2)} and the ${w(3)}. Remember to ${w(4)} before Friday.`
}

export function bodyState(markdown: string): number[] {
  const doc = new Y.Doc()
  doc.getText(BODY).insert(0, markdown)
  return [...Y.encodeStateAsUpdate(doc)]
}
