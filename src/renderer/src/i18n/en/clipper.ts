export const prefixes = ['clipper']

export const messages = {
  'clipper.appName': 'Devot Web Clipper',
  'clipper.title': 'Title',
  'clipper.notebook': 'Notebook',
  'clipper.mode': 'What to clip',
  'clipper.article': 'Article',
  'clipper.selection': 'Selection',
  'clipper.selectionNone': 'Select text on the page to clip only that part.',
  'clipper.save': 'Save to Devot',
  'clipper.options': 'Clipper Settings',
  'clipper.loading': 'Connecting to Devot…',
  'clipper.working': 'Saving…',
  'clipper.workingImages': 'Saving images: {done} of {total}',
  'clipper.saved': 'Saved to {notebook}',
  'clipper.imagesKept':
    'Images stay as web links. Allow Image Downloads in clipper settings to keep them in the note.',
  'clipper.imagesFailed': 'Some images could not be saved and stay as web links.',
  'clipper.openNote': 'Open in Devot',
  'clipper.done': 'Done',
  'clipper.retry': 'Try Again',
  'clipper.openSettings': 'Open Settings',
  'clipper.setupTitle': 'Connect to Devot',
  'clipper.setupIntro':
    'The clipper saves through Devot’s local HTTP API on this Mac, so Devot needs to be open.',
  'clipper.step1':
    'In Devot, open Settings > Integrations > Local HTTP API. Turn on “Allow Local HTTP API” and set Token Access to “Read and Write”.',
  'clipper.step2': 'Copy the token from Devot and paste it here.',
  'clipper.step3': 'Copy this extension’s origin and add it under Browser Extensions.',
  'clipper.step4': 'Turn on “Allow AI Access” for each notebook you want to clip into.',
  'clipper.port': 'Port',
  'clipper.token': 'Token',
  'clipper.tokenHint': 'Stored only in this browser profile, never synced.',
  'clipper.showToken': 'Show',
  'clipper.hideToken': 'Hide',
  'clipper.extensionOrigin': 'Extension origin',
  'clipper.copyOrigin': 'Copy',
  'clipper.copied': 'Copied',
  'clipper.originCopied': 'Origin copied.',
  'clipper.check': 'Save and Check',
  'clipper.checking': 'Checking…',
  'clipper.checkConnection': 'Devot is open and its local HTTP API is on',
  'clipper.checkOrigin': 'This extension is added in Devot',
  'clipper.checkToken': 'The token is accepted',
  'clipper.checkWrite': 'The token can save notes',
  'clipper.checkNotebooks': 'Notebooks are open to clips',
  'clipper.checkNotebooksCount': '{count} notebooks are open to clips',
  'clipper.connected': 'All set. Click the Devot button in the toolbar on any page to clip it.',
  'clipper.imagesTitle': 'Offline Images',
  'clipper.imagesHint':
    'Saves a copy of each picture into the note, so clips keep their images when the website changes or you are offline. The browser asks once for permission to download images from any website.',
  'clipper.imageAccess': 'Allow Image Downloads',
  'clipper.imagesEnabled': 'On. Images are saved with each clip.',
  'clipper.imagesRemote': 'Not allowed. Images stay as web links.',
  'clipper.E_CLIP_COPY': 'Could not copy. Select the origin and copy it yourself.',
  'clipper.E_HTTP_ORIGIN_REFUSED':
    'Devot doesn’t know this extension yet. Add its origin in Devot under Settings > Integrations > Local HTTP API > Browser Extensions.',
  'clipper.E_NOTE_BODY_TOO_LARGE':
    'This page is longer than a note can hold (1 MB). Select part of it and clip the selection.',
  'clipper.E_CLIP_EMPTY': 'No article found on this page. Select the part you want and try again.',
  'clipper.E_CLIP_URL': 'This page can’t be clipped. Open a web page and try again.',
  'clipper.E_CLIP_CONNECTION':
    'Can’t reach Devot. Make sure Devot is open and “Allow Local HTTP API” is on, with the same port as here.',
  'clipper.E_CLIP_SETTINGS': 'Paste the token from Devot and check the port.',
  'clipper.E_CLIP_NOTEBOOKS':
    'No notebook is open to clips yet. In Devot, turn on “Allow AI Access” for a notebook.',
  'clipper.E_CLIP_API': 'Clipping failed. Try again, or check the clipper settings.',
  'clipper.E_HTTP_TOKEN_MISSING': 'Paste the token from Devot and check the port.',
  'clipper.E_HTTP_TOKEN_INVALID':
    'Devot refused the token. Copy it again from Devot; making a new token there replaces the old one.',
  'clipper.E_HTTP_READ_ONLY':
    'This token can only read. In Devot, set Token Access to “Read and Write”, then paste the new token here.',
  'clipper.E_HTTP_RATE_LIMITED': 'Devot is busy. Try again in a moment.',
  'clipper.E_LICENCE_REQUIRED': 'Saving notes needs a Devot license.',
  'clipper.E_BOOK_NOT_FOUND':
    'That notebook is no longer open to clips. Choose another one, or turn on “Allow AI Access” for it in Devot.',
} as const
