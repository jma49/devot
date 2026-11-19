export const prefixes = ['clipper']

export const messages = {
  'clipper.appName': 'Devot Web Clipper',
  'clipper.title': 'Title',
  'clipper.notebook': 'Notebook',
  'clipper.article': 'Clip article',
  'clipper.selection': 'Clip selection',
  'clipper.options': 'Clipper settings',
  'clipper.port': 'Local API port',
  'clipper.token': 'Local API Bearer token (stored on this device)',
  'clipper.save': 'Save settings',
  'clipper.ready': 'Ready to clip.',
  'clipper.working': 'Clipping…',
  'clipper.saved': 'Saved to Devot.',
  'clipper.settingsSaved': 'Settings saved.',
  'clipper.extensionOrigin': 'Extension origin',
  'clipper.copyOrigin': 'Copy origin',
  'clipper.originCopied': 'Extension origin copied.',
  'clipper.registerOrigin':
    'Add this origin in Devot Settings > Integrations > Local HTTP API > Browser extensions.',
  'clipper.E_CLIP_COPY': 'Could not copy. Select and copy the origin manually.',
  'clipper.E_HTTP_ORIGIN_REFUSED':
    "Devot doesn't know this extension yet. Add it in Devot's Settings, under Local HTTP API → Browser extensions.",
  'clipper.imageAccess': 'Enable offline images (optional website access)',
  'clipper.imagesEnabled': 'Offline images enabled. Supported images will be saved with each clip.',
  'clipper.imagesRemote': 'Website access was not granted. Images will remain remote links.',
  'clipper.E_NOTE_BODY_TOO_LARGE':
    'This clip exceeds the 1 MB Markdown limit. Select a smaller section.',
  'clipper.E_CLIP_EMPTY': 'No article or selection found. Try selecting the content first.',
  'clipper.E_CLIP_URL': 'Open an HTTP or HTTPS article to clip.',
  'clipper.E_CLIP_CONNECTION': 'Cannot reach Devot. Open the app and enable its local HTTP API.',
  'clipper.E_CLIP_SETTINGS': 'Set a valid port and token in clipper settings.',
  'clipper.E_CLIP_NOTEBOOKS':
    'No accessible notebooks. Enable Allow AI Access on a notebook in Devot.',
  'clipper.E_CLIP_API': 'Clipping failed. Check Devot, the selected page and the API settings.',
  'clipper.E_HTTP_TOKEN_INVALID': 'Token refused. Update the token in clipper settings.',
  'clipper.E_HTTP_READ_ONLY': 'This token is read-only. Use a read/write token.',
  'clipper.E_HTTP_RATE_LIMITED': 'Too many requests. Try again shortly.',
  'clipper.E_BOOK_NOT_FOUND': 'Notebook unavailable. Reopen the clipper to refresh notebooks.',
} as const
