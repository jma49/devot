import { pointsElsewhere } from './diagramCss'

// Observed in tests/fixtures/diagram-svg-attributes.json; see Security, diagram SVG corpus.
const ATTRIBUTES: Readonly<Record<string, string>> = {
  circle: 'class cx cy fill height overflow r stroke stroke-width style width',
  clipPath: 'id',
  defs: '',
  desc: 'id',
  ellipse: 'class cx cy data-name id rx ry style',
  feDropShadow: 'dx dy flood-color flood-opacity stdDeviation',
  filter: 'height id width',
  g: 'alignment-baseline aria-label class data-boundary-type data-color-id data-depth data-entity-1 data-entity-2 data-entity-uid data-et data-id data-link-type data-look data-path data-qualified-name data-source-line data-type data-usecase-id data-usecase-kind data-venn-sets dominant-baseline dy fill font-family font-size id mask opacity role stroke-opacity style text-anchor transform x y',
  line: 'class data-et data-from data-id data-to id marker-end marker-start name opacity stroke stroke-dasharray stroke-width style x1 x2 y1 y2',
  linearGradient: 'gradientUnits id x1 x2',
  marker: 'class id markerHeight markerUnits markerWidth orient refX refY stroke-width viewBox',
  mask: 'height id maskUnits width x y',
  path: 'aria-label class d data-depth data-edge data-et data-id data-look data-name data-path data-points data-usecase-id data-usecase-kind fill fill-opacity fill-rule id marker-end marker-start role stroke stroke-dasharray stroke-linejoin stroke-width style transform viewBox',
  polygon: 'class fill points stroke stroke-width style transform',
  rect: 'aria-hidden class data-look fill fill-opacity filter height id name opacity rx ry stroke stroke-opacity stroke-width style transform transform-origin width x y',
  stop: 'offset stop-color',
  style: '',
  svg: 'aria-label aria-describedby aria-labelledby aria-roledescription class font-family font-size height id overflow preserveAspectRatio role style version viewBox width xmlns',
  symbol: 'clip-rule fill-rule height id width',
  text: 'alignment-baseline class clip-path dominant-baseline dy fill font-family font-size font-style font-weight id stroke style text-anchor transform x xml:space y',
  title: 'id',
  tspan: 'alignment-baseline class dy font-style font-weight style text-anchor x xml:space y',
}

const elements = new Map(
  Object.entries(ATTRIBUTES).map(([tag, attrs]) => [
    tag,
    new Set(attrs.split(' ').filter(Boolean)),
  ]),
)

export function allowsSvgElement(tag: string): boolean {
  return elements.has(tag)
}

export function allowsSvgAttribute(tag: string, name: string, value: string): boolean {
  return elements.get(tag)?.has(name) === true && !pointsElsewhere(value)
}

export function foreignObjectText(content: string, box: Record<string, unknown>) {
  const coordinate = (key: string): number => {
    const value = Number(box[key])
    return Number.isFinite(value) ? value : 0
  }
  const centre = (start: string, size: string): string => {
    const value = coordinate(start) + coordinate(size) / 2
    return Number.isFinite(value) ? String(value) : '0'
  }
  return {
    attributes: {
      x: centre('x', 'width'),
      y: centre('y', 'height'),
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
    },
    text: content.replace(/\s+/g, ' ').trim(),
  }
}
