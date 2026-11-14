// English UI strings: the source locale. Every other locale translates these keys; a missing
// translation falls back to English. A key goes in the area module whose `prefixes` hold the text
// before its first dot; a new prefix joins the module of its UI area (catalog.test.ts checks both).
import * as ai from './ai'
import * as app from './app'
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

export const areas = {
  ai,
  app,
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
}

export const en = {
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
} as const

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, string>
