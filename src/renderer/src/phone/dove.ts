import doveUrl from '../../../../design/app-icon/dove-small.svg?url'

/** A production build inlines small SVGs as data URLs holding `'`, which only a quoted url() accepts. */
export function cssUrl(url: string): string {
  const escaped = url.replace(/["\\\n]/g, (c) => (c === '\n' ? '\\a ' : `\\${c}`))
  return `url("${escaped}")`
}

const dove = cssUrl(doveUrl)

export const doveMask = { maskImage: dove, WebkitMaskImage: dove } as const
