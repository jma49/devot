// English UI strings: the source locale. Every other locale translates these keys; a missing
// translation falls back to English. A key goes in the area module whose `prefixes` hold the text
// before its first dot; a new prefix joins the module of its UI area (catalog.test.ts checks both).
// The Mac's native menus (`native.ts`) are Rust's alone, so they stay out of what the page parses.
import * as ai from './ai'
import * as app from './app'
import * as browserExtensions from './browserExtensions'
import * as commands from './commands'
import * as editor from './editor'
import * as files from './files'
import * as history from './history'
import * as integrations from './integrations'
import * as licence from './licence'
import * as noteList from './noteList'
import * as phone from './phone'
import * as settings from './settings'
import * as share from './share'
import * as intents from './intents'
import * as sidebar from './sidebar'
import * as sync from './sync'
import * as widget from './widget'

export * as clipper from './clipper'

export const areas = {
  ai,
  app,
  browserExtensions,
  commands,
  editor,
  files,
  history,
  integrations,
  licence,
  noteList,
  phone,
  settings,
  share,
  intents,
  sidebar,
  sync,
  widget,
}

export const startup = {
  ...ai.messages,
  ...app.messages,
  ...commands.messages,
  ...editor.messages,
  ...files.messages,
  ...history.messages,
  ...integrations.messages,
  ...licence.messages,
  ...noteList.messages,
  ...phone.messages,
  ...settings.messages,
  ...share.messages,
  ...intents.messages,
  ...sidebar.messages,
  ...sync.messages,
  ...widget.messages,
} as const

export const en = /* @__PURE__ */ Object.assign({}, startup, browserExtensions.messages)

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, string>
