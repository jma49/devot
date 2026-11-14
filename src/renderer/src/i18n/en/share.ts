export const prefixes = ['share']

/** The iPhone's Share Extension, which reads them from its own string catalog (scripts/i18n/apple.ts). */
export const messages = {
  'share.sheet.title': 'Devot',
  'share.post': 'Post',
  'share.cancel': 'Cancel',
  'share.field.title': 'Title',
  'share.field.text': 'Text',
  'share.images.count': 'Images: {count}',
  'share.images.skipped': 'Some images could not be added.',
  'share.error.title': 'Could Not Add to Devot',
  'share.error.empty': 'Add a title, some text, a link or an image.',
  'share.error.tooLarge': 'This is too large to add to Devot. Try fewer images.',
  'share.error.save': 'Devot could not keep this. Try again.',
  'share.ok': 'OK',
} as const
