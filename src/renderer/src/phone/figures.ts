export interface FigurePart {
  text: string
  figure: boolean
}

/** A message split so its filled placeholders can take the figures style and its words the body font. */
export function figureParts(template: string, values: Record<string, string>): FigurePart[] {
  const parts: FigurePart[] = []
  const push = (text: string, figure: boolean) => {
    if (text === '') return
    const last = parts.at(-1)
    if (last && !last.figure && !figure) last.text += text
    else parts.push({ text, figure })
  }
  let at = 0
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const value = values[match[1]!]
    if (value === undefined) continue
    push(template.slice(at, match.index), false)
    push(value, true)
    at = match.index + match[0].length
  }
  push(template.slice(at), false)
  return parts
}
