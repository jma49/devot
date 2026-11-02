import type { Messages } from './en'

/** English messages that name the Mac, as the iPhone layout words them. */
export const enPhone: Partial<Messages> = {
  'editorSettings.detail': 'These settings apply only on this iPhone.',
  'editorSettings.installedFontHint':
    'A font installed on this iPhone. Text it cannot show appears in the default font.',
  'editorSettings.importedFontHint':
    'A font file you imported (TTF, OTF, WOFF or WOFF2, up to 50 MB). It stays on this iPhone.',
  'appearanceSettings.animationsHint':
    'Whether screens, lists, menus and sheets move. Follow System uses the Reduce Motion setting in Settings > Accessibility > Motion.',
  'aiSettings.detail':
    'Devot sends text to an AI provider only when you start an AI action, and only text from notebooks with Allow AI Access on. Requests go from this iPhone straight to the provider you choose, with your own key. Keys are kept in the iOS Keychain, never in Devot’s settings files.',
  'aiSettings.endpointHint':
    'Where requests go: an https address, or an http address for a server on this iPhone. Leave empty for the default.',
  'usage.privacy':
    'Only counts are recorded, never note content, titles or names. Nothing leaves this iPhone.',
  'usage.storage': 'Stored on this iPhone',
  'usage.retained':
    'Charts use the records still stored on this iPhone; older or excess records are not included.',
  'usage.detail':
    'Devot keeps a record of how it is used on this iPhone, such as how many notes are created and how many results a search finds. It never includes note content, titles or names, and nothing leaves this iPhone.',
  'usage.countOne': '{count} event is stored on this iPhone.',
  'usage.countOther': '{count} events are stored on this iPhone.',
  'usage.confirmClearDetail':
    'Every stored usage event is deleted from this iPhone. This cannot be undone.',
}
