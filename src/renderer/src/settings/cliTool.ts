import type { MessageKey } from '../i18n'

export function cliToolFailure(code: string): MessageKey {
  return code === 'E_CLI_APP_NOT_IN_APPLICATIONS'
    ? 'generalSettings.commandLineNotInApplications'
    : 'generalSettings.commandLineFailed'
}
