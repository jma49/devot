export const MAX_TAG_NAME_CHARS = 100

export const sameName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0
