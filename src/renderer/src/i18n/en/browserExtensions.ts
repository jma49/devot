export const prefixes = ['browserExtensions']

export const messages = {
  'browserExtensions.title': 'Browser extensions',
  'browserExtensions.hint':
    'Only registered extensions may use this API. Copy the origin from the clipper settings. Changes apply immediately.',
  'browserExtensions.empty': 'No browser extensions registered.',
  'browserExtensions.origin': 'Extension origin',
  'browserExtensions.add': 'Add extension',
  'browserExtensions.remove': 'Remove',
  'browserExtensions.removeOrigin': 'Remove {origin}',
  'browserExtensions.invalid':
    'Enter up to eight extension origins, without a trailing slash, path or port.',
} as const
