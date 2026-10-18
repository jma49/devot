// Math: `$...$`, `$$...$$` and ```math blocks, rendered to MathML by temml,
// which the system web view lays out natively. temml loads only for notes
// that contain math. Its output passes a MathML allowlist before use.
import type { Element, ElementContent, Properties, Root, RootContent } from 'hast'
import { PREVIEW_API_VERSION, type PreviewRenderer } from './registry'

export interface MathEngine {
  /** MathML markup for `tex`; throws on invalid input. */
  render(tex: string, display: boolean): string
  /** Parses an HTML fragment into hast (no DOM needed). */
  parse(html: string): Root
}

export async function loadMathEngine(): Promise<MathEngine> {
  const [{ default: temml }, { fromHtml }] = await Promise.all([
    import('temml'),
    import('hast-util-from-html'),
  ])
  return {
    render: (tex, display) =>
      // `annotate` keeps the TeX in the MathML (shown by no browser), so an
      // exported page imports as math again (htmlImport.ts).
      temml.renderToString(tex, {
        displayMode: display,
        throwOnError: true,
        trust: false,
        annotate: true,
      }),
    parse: (html) => fromHtml(html, { fragment: true }),
  }
}

const MATHML_TAGS = new Set([
  'math',
  'semantics',
  'annotation',
  'mrow',
  'mi',
  'mn',
  'mo',
  'ms',
  'mtext',
  'mspace',
  'msup',
  'msub',
  'msubsup',
  'mfrac',
  'msqrt',
  'mroot',
  'mover',
  'munder',
  'munderover',
  'mmultiscripts',
  'mprescripts',
  'none',
  'mtable',
  'mtr',
  'mtd',
  'mlabeledtr',
  'mpadded',
  'mphantom',
  'mstyle',
  'menclose',
  'merror',
])

const MATHML_ATTRIBUTES = new Set([
  'display',
  'displaystyle',
  'scriptlevel',
  'mathvariant',
  'mathsize',
  'stretchy',
  'fence',
  'separator',
  'lspace',
  'rspace',
  'width',
  'height',
  'depth',
  'voffset',
  'accent',
  'accentunder',
  'movablelimits',
  'largeop',
  'symmetric',
  'minsize',
  'maxsize',
  'linethickness',
  'columnalign',
  'columnspacing',
  'rowalign',
  'rowspacing',
  'columnlines',
  'rowlines',
  'frame',
  'notation',
  'encoding',
])
const SAFE_VALUE = /^[\w .,%#+-]*$/
/** The encoding of the TeX source annotation (it has a `/`, which SAFE_VALUE refuses). */
const TEX_ENCODING = 'application/x-tex'

/** Keeps only allowlisted MathML elements and attributes; no styles, no links. */
function cleanMath(node: RootContent): ElementContent[] {
  if (node.type === 'text') return [node]
  if (node.type !== 'element') return []
  if (!MATHML_TAGS.has(node.tagName)) return node.children.flatMap(cleanMath)
  const properties: Properties = {}
  for (const [key, value] of Object.entries(node.properties)) {
    const name = key.toLowerCase()
    if (!MATHML_ATTRIBUTES.has(name)) continue
    if (SAFE_VALUE.test(String(value)) || (name === 'encoding' && value === TEX_ENCODING)) {
      properties[name] = value
    }
  }
  return [{ ...node, properties, children: node.children.flatMap(cleanMath) }]
}

const isMath = (node: Element) =>
  node.tagName === 'code' &&
  ((node.properties['className'] as string[] | undefined) ?? []).includes('language-math')

function source(node: Element): string {
  return node.children.map((c) => (c.type === 'text' ? c.value : '')).join('')
}

type Found = { parent: Root | Element; index: number; code: Element; display: boolean }

function findMath(parent: Root | Element, out: Found[] = []): Found[] {
  parent.children.forEach((child, index) => {
    if (child.type !== 'element') return
    const inner =
      child.tagName === 'pre' ? child.children.find((c) => c.type === 'element') : undefined
    if (inner?.type === 'element' && isMath(inner)) {
      out.push({ parent, index, code: inner, display: true })
    } else if (isMath(child)) {
      const tex = source(child)
      // As on GitHub, `$` next to a space is not math: "$5 and $6" is prose.
      if (tex.trim() !== tex || tex === '') {
        parent.children[index] = { type: 'text', value: `$${tex}$` }
      } else {
        out.push({ parent, index, code: child, display: false })
      }
    } else {
      findMath(child, out)
    }
  })
  return out
}

export function createMathRenderer(
  load: () => Promise<MathEngine> = loadMathEngine,
): PreviewRenderer {
  return {
    id: 'devot.math',
    apiVersion: PREVIEW_API_VERSION,
    async transform(tree) {
      const found = findMath(tree)
      if (found.length === 0) return
      const engine = await load()
      for (const { parent, index, code, display } of found) {
        const tex = source(code)
        let replacement: ElementContent
        try {
          const math = engine.parse(engine.render(tex, display)).children.flatMap(cleanMath)
          replacement = {
            type: 'element',
            tagName: display ? 'div' : 'span',
            properties: { className: [display ? 'math-display' : 'math-inline'] },
            children: math,
          }
        } catch {
          replacement = {
            type: 'element',
            tagName: 'code',
            properties: { className: ['math-error'] },
            children: [{ type: 'text', value: tex }],
          }
        }
        // The math takes the block's place in the source (see `rewrite`).
        const replaced = parent.children[index]
        if (replaced?.position) replacement.position = replaced.position
        parent.children[index] = replacement
      }
    },
  }
}
