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
  ground: string
  series1: string
  series2: string
  series3: string
  series4: string
  series5: string
  series6: string
  onSeries: string
  barTask: string
  barActive: string
  barCrit: string
  onBar: string
}

const PALETTE_TOKENS = {
  card: 'color.fill.card',
  hairline: 'color.line.hairline',
  edge: 'color.text.tertiary',
  text: 'color.text.primary',
  label: 'color.text.secondary',
  ground: 'color.surface.editor',
  series1: 'color.chart.series-1',
  series2: 'color.chart.series-2',
  series3: 'color.chart.series-3',
  series4: 'color.chart.series-4',
  series5: 'color.chart.series-5',
  series6: 'color.chart.series-6',
  onSeries: 'color.chart.on-series',
  barTask: 'color.chart.bar-task',
  barActive: 'color.chart.bar-active',
  barCrit: 'color.chart.bar-crit',
  onBar: 'color.chart.on-bar',
} as const satisfies Record<keyof DiagramPalette, ThemeColor>

/** Mermaid drops a theme variable with a `/`, so its variables are hex; themeCSS keeps the exact token. */
function themeVariable(token: string): string {
  const { rgb, alpha } = parseColor(token)
  return toHex(rgb, alpha)
}

export function diagramPalette(read: (token: ThemeColor) => string): DiagramPalette {
  const keys = Object.keys(PALETTE_TOKENS) as (keyof DiagramPalette)[]
  return Object.fromEntries(
    keys.map((name) => [name, read(PALETTE_TOKENS[name]).trim()]),
  ) as unknown as DiagramPalette
}

/** Exported and printed pages show a diagram on a light surface in every appearance. */
export const exportPalette = diagramPalette((token) => light[token])

const AXIS_LABEL_GAP = 8
/** Wider than most of a short date in the caption font, so an estimate never lets two touch. */
const AXIS_LABEL_WIDTH = 42

/**
 * Settings that are not colours. A gantt chart spreads over the width it is
 * given, so one drawn wider than its pane would shrink to fit, type and all.
 */
export function diagramConfig(width = parseFloat(sizes['size.reading-width'])) {
  return {
    gantt: {
      useWidth: width,
      axisFormat: '%b %-d',
      barHeight: 20,
      barGap: 5,
      topPadding: 44,
      fontSize: parseFloat(sizes['font.size.caption']),
      sectionFontSize: parseFloat(sizes['font.size.caption']),
    },
    // Mermaid's default is a foreignObject, which the preview drops.
    journey: { textPlacement: 'tspan' },
  }
}

export function diagramTheme(
  palette: DiagramPalette,
  appearance: 'light' | 'dark',
  fontFamily: string,
) {
  const { card, hairline, edge, text, label, onSeries } = palette
  const variable = {
    card: themeVariable(card),
    hairline: themeVariable(hairline),
    edge: themeVariable(edge),
    text: themeVariable(text),
    label: themeVariable(label),
    ground: themeVariable(palette.ground),
    onSeries: themeVariable(onSeries),
    onBar: themeVariable(palette.onBar),
  }
  const seriesTokens = [
    palette.series1,
    palette.series2,
    palette.series3,
    palette.series4,
    palette.series5,
    palette.series6,
  ]
  const series = seriesTokens.map(themeVariable)
  const dataColours = (name: string, count: number, first = 0) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`${name}${i + first}`, series[i % series.length]!]),
    )
  const every = (name: string, count: number, colour: string) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`${name}${i}`, colour]))
  const bar = {
    task: themeVariable(palette.barTask),
    active: themeVariable(palette.barActive),
    crit: themeVariable(palette.barCrit),
  }
  const captionSize = sizes['font.size.caption']
  const themeVariables = {
    ...dataColours('pie', 12, 1),
    ...dataColours('cScale', 12),
    ...dataColours('cScaleInv', 12),
    ...dataColours('cScalePeer', 12),
    ...every('cScaleLabel', 12, variable.onSeries),
    ...dataColours('git', 8),
    ...every('gitInv', 8, variable.onSeries),
    ...every('gitBranchLabel', 8, variable.onSeries),
    ...dataColours('fillType', 8),
    ...dataColours('actor', 6),
    pieOpacity: '1',
    pieStrokeColor: variable.ground,
    pieStrokeWidth: '0px',
    pieOuterStrokeColor: variable.ground,
    pieOuterStrokeWidth: '0px',
    pieSectionTextColor: variable.onSeries,
    pieSectionTextSize: captionSize,
    pieTitleTextColor: variable.text,
    pieTitleTextSize: sizes['font.size.body'],
    pieLegendTextColor: variable.label,
    pieLegendTextSize: captionSize,
    commitLabelColor: variable.label,
    commitLabelBackground: variable.ground,
    commitLabelFontSize: captionSize,
    tagLabelColor: variable.label,
    tagLabelBackground: variable.ground,
    tagLabelBorder: variable.hairline,
    tagLabelFontSize: captionSize,
    taskBkgColor: bar.task,
    taskBorderColor: bar.task,
    activeTaskBkgColor: bar.active,
    activeTaskBorderColor: bar.active,
    doneTaskBkgColor: variable.card,
    doneTaskBorderColor: variable.card,
    critBkgColor: bar.crit,
    critBorderColor: bar.crit,
    taskTextColor: variable.onBar,
    taskTextDarkColor: variable.onBar,
    taskTextLightColor: variable.onBar,
    taskTextClickableColor: variable.onBar,
    taskTextOutsideColor: variable.text,
    todayLineColor: variable.edge,
    gridColor: variable.hairline,
    sectionBkgColor: variable.ground,
    sectionBkgColor2: variable.ground,
    altSectionBkgColor: variable.ground,
    excludeBkgColor: variable.card,
    faceColor: variable.ground,
    darkMode: appearance === 'dark',
    fontFamily,
    fontSize: sizes['font.size.footnote'],
    background: variable.ground,
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
    edgeLabelBackground: variable.ground,
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
  // Mermaid numbers a section's colour one above its class.
  const sectionFills = seriesTokens
    .map((colour, i) => `.section-${i - 1} .node-bkg { fill: ${colour} !important; }`)
    .join('\n')
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
      font-size: ${captionSize};
      fill: ${label};
    }
    .edgeLabel rect.background {
      fill: none;
    }
    line {
      stroke: ${edge} !important;
      stroke-width: ${sizes['size.diagram-edge']} !important;
    }
    rect.section {
      opacity: 0 !important;
    }
    .grid .tick line {
      stroke: ${hairline} !important;
      opacity: 1;
    }
    .grid path {
      stroke: none;
    }
    .grid .tick text {
      fill: ${edge};
      font-size: ${captionSize};
    }
    .sectionTitle, .sectionTitle0, .sectionTitle1, .sectionTitle2, .sectionTitle3 {
      fill: ${label};
      font-size: ${captionSize};
      font-weight: 600;
    }
    .titleText {
      fill: ${text};
      font-size: ${sizes['font.size.body']};
      font-weight: 600;
    }
    rect.task {
      stroke: none !important;
      stroke-width: 0 !important;
      rx: ${sizes['radius.diagram-bar']};
      ry: ${sizes['radius.diagram-bar']};
    }
    .taskText, .taskTextOutsideRight, .taskTextOutsideLeft {
      font-size: ${captionSize} !important;
    }
    .done0, .done1, .done2, .done3, .doneCrit0, .doneCrit1, .doneCrit2, .doneCrit3 {
      fill: ${card} !important;
    }
    .doneText0, .doneText1, .doneText2, .doneText3,
    .doneCritText0, .doneCritText1, .doneCritText2, .doneCritText3 {
      fill: ${label} !important;
    }
    .commit-label-bkg {
      fill: none;
    }
    .pieOuterCircle {
      fill: none;
    }
    .slice {
      font-weight: 500;
    }
    .legend text {
      fill: ${label};
    }
    .arrow {
      stroke-width: ${sizes['size.diagram-git-line']} !important;
    }
    .commit-bullets circle {
      r: ${sizes['size.diagram-git-commit']};
    }
    .commit-bullets circle.commit-merge {
      r: ${sizes['size.diagram-git-merge']};
    }
    .eventWrapper {
      filter: none;
    }
    .mindmap-node .node-bkg, .timeline-node .node-bkg, rect.task-line {
      stroke: none;
    }
    .mindmap-node line, .mindmap-node .node-line-0, .mindmap-node [class*="node-line"] {
      stroke: none !important;
    }
    ${sectionFills}
    .section-root .node-bkg {
      fill: ${card} !important;
    }
    .mindmap-node text, .mindmap-node tspan, .timeline-node text, .timeline-node tspan,
    [class*="section-"] text, [class*="section-"] tspan,
    [class*="task-type"] ~ text, [class*="task-type"] ~ text tspan,
    [class*="section-type"] ~ text, [class*="section-type"] ~ text tspan {
      fill: ${onSeries} !important;
    }
    .section-root text, .section-root tspan {
      fill: ${text} !important;
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

/** The tick positions that keep a label when each label is `width` wide: the first, then each one clear of the last. */
export function labelledTicks(positions: readonly number[], width: number): number[] {
  const kept: number[] = []
  for (const x of positions)
    if (kept.length === 0 || x - kept[kept.length - 1]! >= width + AXIS_LABEL_GAP) kept.push(x)
  return kept
}

/** Cuts the gaps between pie slices out of the drawing, so what shows through them is the real surface: glass has no colour a line could match. */
function cutPieGaps(root: Element): void {
  const slices = Array.from(root.querySelectorAll('path.pieCircle'))
  const parent = slices[0]?.parentElement
  if (!parent) return
  const svgNs = root.namespaceURI
  const make = (name: string) => root.ownerDocument.createElementNS(svgNs, name)
  const mask = make('mask')
  mask.id = `${root.id}-pie-gaps`
  const reach = '10000'
  const bounds = {
    x: `-${reach}`,
    y: `-${reach}`,
    width: `${2 * Number(reach)}`,
    height: `${2 * Number(reach)}`,
  }
  mask.setAttribute('maskUnits', 'userSpaceOnUse')
  for (const [name, value] of Object.entries(bounds)) mask.setAttribute(name, value)
  const kept = make('rect')
  for (const [name, value] of Object.entries(bounds)) kept.setAttribute(name, value)
  kept.setAttribute('fill', 'white')
  mask.append(kept)
  for (const slice of slices) {
    const cut = make('path')
    cut.setAttribute('d', slice.getAttribute('d') ?? '')
    cut.setAttribute('fill', 'none')
    cut.setAttribute('stroke', 'black')
    cut.setAttribute('stroke-width', String(parseFloat(sizes['space.1'])))
    mask.append(cut)
  }
  const group = make('g')
  group.setAttribute('mask', `url(#${mask.id})`)
  parent.insertBefore(group, slices[0]!)
  group.append(...slices)
  parent.insertBefore(mask, group)
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
 * growing the drawing to hold it, shrinks the arrowheads, cuts the gaps in a
 * pie, drops the gantt date labels that would collide and lays the today line under the bars. A drawing
 * that cannot be read comes back as it was.
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

  cutPieGaps(root)

  const ticks = Array.from(root.querySelectorAll('.grid .tick'))
    .map((tick) => ({ tick, x: translation(tick)?.x ?? 0 }))
    .sort((a, b) => a.x - b.x)
  const kept = new Set(
    labelledTicks(
      ticks.map(({ x }) => x),
      AXIS_LABEL_WIDTH,
    ),
  )
  for (const { tick, x } of ticks) if (!kept.has(x)) tick.querySelector('text')?.remove()

  const today = root.querySelector('.today')
  const bars = root.querySelector('rect.task')?.parentElement
  if (today && bars) {
    let line: Element = today
    while (line.parentElement && line.parentElement !== bars.parentElement)
      line = line.parentElement
    if (line.parentElement) bars.before(line)
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
    // Mermaid sets the label's box off its own origin: the distance is measured from the box's middle.
    const shift = translation(inner) ?? { x: 0, y: 0 }
    const middleX = shift.x + Number(background.getAttribute('x')) + width / 2
    const middleY = shift.y + Number(background.getAttribute('y')) + height / 2
    const { dx, dy } = besideLine(linePoints(line), { ...at, width, height })
    const x = at.x + dx - middleX
    const y = at.y + dy - middleY
    outer.setAttribute('transform', `translate(${x}, ${y})`)
    right = Math.max(right, x + middleX + width / 2)
    bottom = Math.max(bottom, y + middleY + height / 2)
  }
  if (view.length === 4 && view.every(Number.isFinite)) {
    const width = right - view[0]!
    root.setAttribute('viewBox', `${view[0]} ${view[1]} ${width} ${bottom - view[1]!}`)
    const svg = root as unknown as SVGSVGElement
    if (svg.style?.maxWidth) svg.style.maxWidth = `${width}px`
  }
  return new XMLSerializer().serializeToString(root)
}
