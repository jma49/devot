import { pointsElsewhere } from './diagramCss'

// Observed in tests/fixtures/diagram-svg-attributes.json; see Security, diagram SVG corpus.
const ATTRIBUTES: Readonly<Record<string, string>> = {
  circle: 'class cx cy fill overflow r stroke stroke-width style',
  defs: '',
  desc: 'id',
  feDropShadow: 'dx dy flood-color flood-opacity stdDeviation',
  filter: 'height id width',
  g: 'class data-depth data-entity-1 data-entity-2 data-entity-uid data-et data-id data-link-type data-look data-path data-qualified-name data-source-line data-type fill font-family font-size id mask opacity style text-anchor transform',
  line: 'class data-et data-from data-id data-to id marker-end name stroke stroke-dasharray stroke-width style x1 x2 y1 y2',
  marker: 'class id markerHeight markerUnits markerWidth orient refX refY viewBox',
  mask: 'height id maskUnits width x y',
  path: 'class d data-depth data-edge data-et data-id data-look data-path data-points fill id marker-end marker-start stroke stroke-dasharray stroke-width style transform viewBox',
  polygon: 'class fill points stroke stroke-width style',
  rect: 'class data-look fill filter height id name rx ry stroke stroke-width style transform transform-origin width x y',
  style: '',
  svg: 'aria-label aria-describedby aria-labelledby aria-roledescription class font-family font-size height id preserveAspectRatio role style version viewBox width xmlns',
  symbol: 'clip-rule fill-rule height id width',
  text: 'alignment-baseline class dominant-baseline dy fill font-family font-size id stroke style text-anchor transform x xml:space y',
  title: 'id',
  tspan: 'alignment-baseline class dy font-style font-weight text-anchor x xml:space y',
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
