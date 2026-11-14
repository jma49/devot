export interface ImportChoices {
  wikiLinks: boolean
  /** Front matter tags and other names, `#tags` and callouts. */
  conventions: boolean
}

export const DEFAULT_CHOICES: ImportChoices = { wikiLinks: true, conventions: false }
