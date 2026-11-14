export const MESSAGES = {
  title: 'Shared note',
  opening: 'Opening the note…',
  missingKey:
    'This link is missing the part that unlocks the note. Ask for the whole link, including everything after the # sign.',
  gone: 'This note is no longer shared. Its link has expired or its owner stopped sharing it.',
  broken: 'This note cannot be opened. The link may be incomplete or the page damaged.',
  frame: 'The shared note',
  footer:
    'Shared with Devot. The note was encrypted on its owner’s device; this site cannot read it.',
  home: 'devot.online',
} as const

export type MessageKey = keyof typeof MESSAGES
