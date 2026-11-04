declare module '@plantuml/core' {
  export function renderToString(
    lines: string[],
    success: (svg: string) => void,
    error: (message: string) => void,
    options?: { dark?: boolean; maxSvgSize?: number },
  ): void
}
declare module '@plantuml/core/themes.js'
