// Devot's look for Mermaid diagrams. The preview reads the colours from the
// theme tokens and sends them to the frame, whose document has no tokens.
import { parseColor, toHex } from '../theme/contrast'
import { light, sizes, type ThemeColor } from '../theme/tokens'

export interface DiagramPalette {
  card: string
  hairline: string
  edge: string
  text: string
  label: string
  sheet: string
  series1: string
  series2: string
  series3: string
  series4: string
  series5: string
  series6: string
}

const PALETTE_TOKENS = {
  card: 'color.fill.card',
  hairline: 'color.line.hairline',
  edge: 'color.text.tertiary',
  text: 'color.text.primary',
  label: 'color.text.secondary',
  sheet: 'color.surface.sheet',
  series1: 'color.tag.blue',
  series2: 'color.tag.green',
  series3: 'color.tag.orange',
  series4: 'color.tag.purple',
  series5: 'color.tag.red',
  series6: 'color.tag.yellow',
} as const satisfies Record<keyof DiagramPalette, ThemeColor>

/** Mermaid drops a theme variable with a `/`, so its variables are hex; themeCSS keeps the exact token. */
function themeVariable(token: string): string {
  const { rgb, alpha } = parseColor(token)
  return toHex(rgb, alpha)
}

export function diagramPalette(read: (token: ThemeColor) => string): DiagramPalette {
  const colour = (name: keyof DiagramPalette) => read(PALETTE_TOKENS[name]).trim()
  return {
    card: colour('card'),
    hairline: colour('hairline'),
    edge: colour('edge'),
    text: colour('text'),
    label: colour('label'),
    sheet: colour('sheet'),
    series1: colour('series1'),
    series2: colour('series2'),
    series3: colour('series3'),
    series4: colour('series4'),
    series5: colour('series5'),
    series6: colour('series6'),
  }
}

/** Exported and printed pages show a diagram on a light surface in every appearance. */
export const exportPalette = diagramPalette((token) => light[token])

export function diagramTheme(
  palette: DiagramPalette,
  appearance: 'light' | 'dark',
  fontFamily: string,
) {
  const { card, hairline, edge, text, label, sheet } = palette
  const variable = {
    card: themeVariable(card),
    hairline: themeVariable(hairline),
    edge: themeVariable(edge),
    text: themeVariable(text),
    label: themeVariable(label),
    sheet: themeVariable(sheet),
  }
  const series = [
    palette.series1,
    palette.series2,
    palette.series3,
    palette.series4,
    palette.series5,
    palette.series6,
  ].map(themeVariable)
  // Charts take their data colours from these. Flowcharts draw nodes from mainBkg and themeCSS.
  const dataColours = (name: string, count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`${name}${i}`, series[i % series.length]!]),
    )
  const pieColours = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`pie${i + 1}`, series[i % series.length]!]),
  )
  const themeVariables = {
    ...pieColours,
    ...dataColours('cScale', 12),
    ...dataColours('git', 8),
    ...dataColours('fillType', 8),
    taskBkgColor: series[0]!,
    activeTaskBkgColor: series[1]!,
    doneTaskBkgColor: variable.label,
    critBkgColor: series[4]!,
    sectionBkgColor: variable.card,
    sectionBkgColor2: variable.card,
    altSectionBkgColor: variable.sheet,
    excludeBkgColor: variable.card,
    darkMode: appearance === 'dark',
    fontFamily,
    fontSize: sizes['font.size.footnote'],
    background: variable.sheet,
    primaryColor: series[0]!,
    secondaryColor: series[1]!,
    tertiaryColor: series[2]!,
    mainBkg: variable.card,
    nodeBorder: variable.hairline,
    clusterBkg: variable.card,
    clusterBorder: variable.hairline,
    primaryBorderColor: variable.hairline,
    secondaryBorderColor: variable.hairline,
    tertiaryBorderColor: variable.hairline,
    lineColor: variable.edge,
    defaultLinkColor: variable.edge,
    textColor: variable.text,
    primaryTextColor: variable.text,
    secondaryTextColor: variable.text,
    tertiaryTextColor: variable.text,
    nodeTextColor: variable.text,
    titleColor: variable.text,
    edgeLabelBackground: variable.sheet,
    actorBkg: variable.card,
    actorBorder: variable.hairline,
    actorTextColor: variable.text,
    actorLineColor: variable.edge,
    signalColor: variable.edge,
    signalTextColor: variable.label,
    labelBoxBkgColor: variable.card,
    labelBoxBorderColor: variable.hairline,
    labelTextColor: variable.text,
    loopTextColor: variable.label,
    noteBkgColor: variable.card,
    noteBorderColor: variable.hairline,
    noteTextColor: variable.text,
  }
  const themeCSS = `
    .node .label-container, .node .label-container path {
      fill: ${card};
      stroke: ${hairline};
      stroke-width: ${sizes['size.diagram-node-edge']};
      filter: none;
    }
    .node rect.label-container {
      rx: ${sizes['radius.diagram-node']};
      ry: ${sizes['radius.diagram-node']};
    }
    .node .label text, .node .label tspan {
      fill: ${text};
    }
    .flowchart-link {
      stroke: ${edge};
    }
    .flowchart-link.edge-thickness-normal {
      stroke-width: ${sizes['size.diagram-edge']};
    }
    .marker, .arrowMarkerPath {
      fill: ${edge};
      stroke: ${edge};
    }
    .edgeLabel text, .edgeLabel tspan {
      font-size: ${sizes['font.size.caption']};
      fill: ${label};
    }
    .edgeLabel rect.background {
      fill: ${sheet};
      opacity: 1;
    }
  `
  return { themeVariables, themeCSS }
}

interface Point {
  x: number
  y: number
}

interface Box extends Point {
  width: number
  height: number
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const squared = dx * dx + dy * dy
  const along = squared === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / squared
  const t = Math.min(1, Math.max(0, along))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** How far to move a label centred at `box.x, box.y` so its box clears the line: below a level segment, else to its right. */
export function besideLine(points: readonly Point[], box: Box): { dx: number; dy: number } {
  let nearest: [Point, Point] | undefined
  let least = Infinity
  for (let i = 1; i < points.length; i += 1) {
    const [a, b] = [points[i - 1]!, points[i]!]
    const distance = distanceToSegment(box, a, b)
    if (distance < least) {
      least = distance
      nearest = [a, b]
    }
  }
  if (!nearest) return { dx: 0, dy: 0 }
  const gap = Number.parseFloat(sizes['size.diagram-label-gap'])
  const [a, b] = nearest
  return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
    ? { dx: 0, dy: box.height / 2 + gap }
    : { dx: box.width / 2 + gap, dy: 0 }
}

const translation = (el: Element) => {
  const match = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/.exec(
    el.getAttribute('transform') ?? '',
  )
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null
}

function linePoints(path: Element | null): Point[] {
  try {
    const points: unknown = JSON.parse(atob(path?.getAttribute('data-points') ?? ''))
    return Array.isArray(points) ? (points as Point[]) : []
  } catch {
    return []
  }
}

/**
 * What Mermaid has no setting for: moves each edge label beside its line,
 * growing the drawing to hold it, and shrinks the arrowheads. A drawing that
 * cannot be read comes back as it was.
 */
export function finishDrawing(markup: string): string {
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const root = parsed.documentElement
  if (root.localName !== 'svg') return markup

  for (const marker of Array.from(root.querySelectorAll('marker'))) {
    if (!/-point(End|Start)(-margin)?$/.test(marker.id)) continue
    marker.setAttribute('markerWidth', String(parseFloat(sizes['size.diagram-arrow-length'])))
    marker.setAttribute('markerHeight', String(parseFloat(sizes['size.diagram-arrow-width'])))
  }

  const view = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  let right = (view[0] ?? 0) + (view[2] ?? 0)
  let bottom = (view[1] ?? 0) + (view[3] ?? 0)
  for (const outer of Array.from(root.querySelectorAll('.edgeLabel'))) {
    const inner = outer.querySelector('.label')
    const background = inner?.querySelector('rect.background')
    const at = translation(outer)
    const id = inner?.getAttribute('data-id')
    if (!inner || !background || !at || !id) continue
    const width = Number(background.getAttribute('width'))
    const height = Number(background.getAttribute('height'))
    if (!width || !height) continue
    const line = root.querySelector(
      `[data-id="${CSS.escape(id)}"].flowchart-link, [data-id="${CSS.escape(id)}"][data-edge]`,
    )
    const { dx, dy } = besideLine(linePoints(line), { ...at, width, height })
    const x = at.x + dx
    const y = at.y + dy
    outer.setAttribute('transform', `translate(${x}, ${y})`)
    right = Math.max(right, x + width / 2)
    bottom = Math.max(bottom, y + height / 2)
  }
  if (view.length === 4 && view.every(Number.isFinite)) {
    const width = right - view[0]!
    root.setAttribute('viewBox', `${view[0]} ${view[1]} ${width} ${bottom - view[1]!}`)
    const svg = root as unknown as SVGSVGElement
    if (svg.style?.maxWidth) svg.style.maxWidth = `${width}px`
  }
  return new XMLSerializer().serializeToString(root)
}
