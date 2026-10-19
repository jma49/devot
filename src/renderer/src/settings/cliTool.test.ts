import { describe, expect, it } from 'vitest'
import { cliToolFailure } from './cliTool'

describe('a command line tool failure', () => {
  it('asks to move Devot to Applications when it runs from a disk image or a moved copy', () => {
    expect(cliToolFailure('E_CLI_APP_NOT_IN_APPLICATIONS')).toBe(
      'generalSettings.commandLineNotInApplications',
    )
    expect(cliToolFailure('E_CLI_INSTALL_FAILED')).toBe('generalSettings.commandLineFailed')
  })
})
