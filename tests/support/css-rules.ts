// A rough CSS reader for the policy tests: each rule as selector and declarations. Comments go
// first; nested blocks (@media) are read as their innermost rules.

export interface CssRule {
  selector: string
  body: Map<string, string>
}

export function cssRules(css: string): CssRule[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector!.replace(/\s+/g, ' ').trim(),
    body: new Map(
      body!
        .split(';')
        .map((d) => d.split(':'))
        .filter((parts) => parts.length >= 2)
        .map(([name, ...value]) => [name!.trim(), value.join(':').replace(/\s+/g, ' ').trim()]),
    ),
  }))
}
