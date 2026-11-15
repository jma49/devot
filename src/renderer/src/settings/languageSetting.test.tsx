// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '../ipc'
import { t } from '../i18n'
import { asLanguageState, languageName } from './appLanguage'
import { LanguageSetting } from './LanguageSetting'

vi.mock('../ipc', () => ({ invoke: vi.fn<() => Promise<unknown>>() }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const SIMPLIFIED_CHINESE = '\u7b80\u4f53\u4e2d\u6587'

let host: HTMLDivElement
let root: Root
let stored: { chosen: string; running: string; available: boolean }

beforeEach(() => {
  stored = { chosen: 'system', running: 'system', available: true }
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'app_language_get') return stored
    if (command === 'app_language_set') {
      stored = { ...stored, chosen: (args as { language: string }).language }
      return stored
    }
    return undefined
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.mocked(invoke).mockReset()
})

async function show() {
  await act(async () => root.render(<LanguageSetting />))
}

const select = () => host.querySelector('select')!
const restart = () =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent === t('generalSettings.restartNow'),
  )

async function choose(value: string) {
  await act(async () => {
    select().value = value
    select().dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('languageName', () => {
  it('names each language in itself, and the system choice in the language shown', () => {
    expect(languageName('en')).toBe('English')
    expect(languageName('zh-Hans')).toBe(SIMPLIFIED_CHINESE)
    expect(languageName('system')).toBe(t('generalSettings.language.system'))
  })
})

describe('asLanguageState', () => {
  it('takes only the three choices', () => {
    expect(asLanguageState({ chosen: 'zh-Hans', running: 'system', available: true })).toEqual({
      chosen: 'zh-Hans',
      running: 'system',
      available: true,
    })
    expect(asLanguageState({ chosen: 'fr', running: 'system', available: true })).toBeNull()
    expect(asLanguageState({ chosen: 'en', running: 'en' })).toBeNull()
    expect(asLanguageState(null)).toBeNull()
  })
})

describe('LanguageSetting', () => {
  it('offers the system and each shipped language, the stored one chosen', async () => {
    stored.chosen = 'en'
    stored.running = 'en'
    await show()
    expect([...select().options].map((o) => o.value)).toEqual(['system', 'en', 'zh-Hans'])
    expect(select().value).toBe('en')
    expect(restart()).toBeUndefined()
  })

  it('saves a choice and offers a restart until the running language matches it', async () => {
    await show()
    await choose('zh-Hans')
    expect(invoke).toHaveBeenCalledWith('app_language_set', { language: 'zh-Hans' })
    expect(host.textContent).toContain(t('generalSettings.languagePending'))
    await act(async () => restart()!.click())
    expect(invoke).toHaveBeenCalledWith('app_language_restart')
    await choose('system')
    expect(restart()).toBeUndefined()
  })

  it('puts the old choice back and says so when the change is refused', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'app_language_get') return stored
      throw new Error('E_APP_LANGUAGE_UNAVAILABLE')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await show()
    await choose('en')
    expect(select().value).toBe('system')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      t('generalSettings.languageFailed'),
    )
  })

  it('shows nothing where Devot cannot set its own language', async () => {
    stored.available = false
    await show()
    expect(host.innerHTML).toBe('')
  })
})
