export const prefixes = ['intent']

/** The iPhone app's Shortcuts actions, which read them by key from the app's string catalog (scripts/i18n/apple.ts). */
export const messages = {
  'intent.add.title': 'Add to Devot',
  'intent.add.description':
    'Adds a note to Devot. It appears in your notes the next time you open Devot.',
  'intent.field.title': 'Title',
  'intent.field.text': 'Text',
  'intent.field.link': 'Link',
  'intent.added': 'Added to Devot.',
  'intent.error.empty': 'Add a title, some text or a link.',
  'intent.error.link': 'The link must be a web address.',
  'intent.error.tooLarge': 'This is too long to add to Devot.',
  'intent.error.full': 'Too many notes are waiting. Open Devot, then try again.',
  'intent.error.save': 'Devot could not keep this. Try again.',
  'intent.today.title': "Open Today's Note",
  'intent.today.description': "Opens today's note in Devot.",
} as const
