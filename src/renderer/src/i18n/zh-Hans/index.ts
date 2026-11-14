import type { Messages } from '../en'
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
import * as sidebar from './sidebar'
import * as sync from './sync'

export { zhHansPhone } from './phoneWording'

export const zhHans: Messages = {
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
  ...sidebar.messages,
  ...sync.messages,
}
