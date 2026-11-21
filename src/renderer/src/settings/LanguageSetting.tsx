import { useEffect, useId, useRef, useState } from 'react'
import { errorCode } from '../backups'
import { failureText, logFailure } from '../failure'
import { t } from '../i18n'
import {
  APP_LANGUAGES,
  appLanguage,
  languageName,
  setAppLanguage,
  type AppLanguage,
  type LanguageState,
} from './appLanguage'
import { Select, Setting, SettingsSection } from './controls'

export function LanguageSetting() {
  const ids = useId()
  const [state, setState] = useState<LanguageState>()
  const [failure, setFailure] = useState<string>()
  const asked = useRef(0)
  useEffect(() => {
    let live = true
    appLanguage().then(
      (read) => live && asked.current === 0 && setState(read),
      () => console.warn('W_APP_LANGUAGE_READ_FAILED'),
    )
    return () => {
      live = false
    }
  }, [])
  if (!state?.available) return null

  const fail = (e: unknown) => setFailure(logFailure(errorCode(e), 'W_APP_LANGUAGE_FAILED'))
  const choose = (language: AppLanguage) => {
    const request = ++asked.current
    setFailure(undefined)
    setState({ ...state, chosen: language })
    setAppLanguage(language).then(
      (saved) => request === asked.current && setState(saved),
      (e: unknown) => {
        if (request !== asked.current) return
        setState(state)
        fail(e)
      },
    )
  }

  return (
    <SettingsSection title="generalSettings.languageGroup">
      {failure ? (
        <p role="alert" className="settings-error">
          {failureText('generalSettings.languageFailed', failure)}
        </p>
      ) : null}
      <Setting
        label="generalSettings.language"
        description={t('generalSettings.languageHint')}
        htmlFor={`${ids}-language`}
        descriptionId={`${ids}-language-hint`}
      >
        <Select
          id={`${ids}-language`}
          value={state.chosen}
          aria-describedby={`${ids}-language-hint`}
          onChange={(e) => choose(e.currentTarget.value as AppLanguage)}
        >
          {APP_LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {languageName(language)}
            </option>
          ))}
        </Select>
      </Setting>
    </SettingsSection>
  )
}
