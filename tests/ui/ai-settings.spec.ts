import type { Page } from '@playwright/test'
import { expect, openSettings, test } from './fixtures'

// Settings > AI. Rust is faked in the page: it keeps the settings, says only whether a key is
// stored, lists each provider's models and answers Try It, as the real commands do.

const SECRET = 'sk-test-0123456789'

interface Options {
  codex?: 'ready' | 'signedOut' | 'notInstalled'
  claude?: 'ready' | 'signedOut' | 'notInstalled'
  active?: string
  refuseSave?: string
  allowed?: number
}

async function fakeRust(page: Page, options: Options = {}) {
  await page.addInitScript((o: Options) => {
    const w = window
    const http = (endpoint: string) => ({
      endpoint: '',
      model: '',
      defaultEndpoint: endpoint,
      defaultModel: '',
      key: 'unset',
      reasoning: null,
    })
    const state: Record<string, any> = {
      active: o.active ?? 'claudeCli',
      suggestOnIdle: false,
      anthropic: http('https://api.anthropic.com'),
      openai: http('https://api.openai.com/v1'),
      cli: {
        claudeCli: { state: o.claude ?? 'ready', model: '', reasoning: null },
        codexCli: { state: o.codex ?? 'ready', model: '', reasoning: null },
      },
      suggestModel: null,
    }
    const model = (id: string, name: string, tier: string | null, reasoning: string[] = []) => ({
      id,
      name,
      tier,
      reasoning,
      defaultReasoning: reasoning.length > 0 ? 'medium' : null,
    })
    const lists: Record<string, unknown> = {
      codexCli: {
        state: 'ready',
        defaultModel: 'gpt-5.5',
        models: [
          model('gpt-5.5', 'GPT-5.5', 'best', ['low', 'medium', 'high']),
          model('gpt-5.5-mini', 'GPT-5.5 Mini', 'fast'),
        ],
      },
      claudeCli: {
        state: 'ready',
        defaultModel: null,
        models: [
          model('opus', 'Opus', 'best', ['low', 'medium', 'high']),
          model('haiku', 'Haiku', 'fast'),
        ],
      },
      openai: {
        state: 'ready',
        defaultModel: null,
        models: [model('o-small', 'O Small', 'fast'), model('o-large', 'O Large', null)],
      },
    }
    const copy = () => JSON.parse(JSON.stringify(state))
    w.devotIpcMocks = {
      ai_settings_get: () => copy(),
      ai_settings_set: (args: { settings: Record<string, any> }) => {
        if (o.refuseSave) throw o.refuseSave
        const s = args.settings
        for (const id of ['anthropic', 'openai']) Object.assign(state[id], s[id])
        for (const id of ['claudeCli', 'codexCli'])
          if (s[id]) Object.assign(state['cli'][id], s[id])
        state['active'] = s['active']
        state['suggestOnIdle'] = s['suggestOnIdle']
        state['suggestModel'] = s['suggestModel'] ?? null
        return copy()
      },
      ai_key_set: (args: { provider: string }) => {
        state[args.provider].key = 'set'
        return copy()
      },
      ai_key_clear: (args: { provider: string }) => {
        state[args.provider].key = 'unset'
        return copy()
      },
      ai_cli_refresh: () => {
        state['cli'].codexCli.state = 'ready'
        return copy()
      },
      ai_models: (args: { providers: string[] }) =>
        Object.fromEntries(args.providers.map((p) => [p, lists[p]])),
      ai_try: (args: { provider: string; model: string }) => ({
        provider: args.provider,
        model: args.model,
        elapsedMs: 840,
      }),
      settings_ai_access_summary: { notebooks: 3, allowed: o.allowed ?? 2 },
    }
  }, options)
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) => window.devotIpcCalls.filter((call) => call.cmd === c).map((call) => call.args),
    cmd,
  )

test('one Model pop-up picks a provider’s model, and its reasoning starts at the default', async ({
  page,
}) => {
  await fakeRust(page)
  await openSettings(page, 'AI')
  const panel = page.getByRole('tabpanel')
  await expect(panel).toContainText('only when you start an AI action')
  await expect
    .poll(() => calls(page, 'ai_models'))
    .toEqual([{ providers: ['claudeCli', 'codexCli'], refresh: false }])

  await panel.getByRole('button', { name: /^Model:/ }).click()
  const picker = page.getByRole('dialog', { name: 'Choose a Model' })
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: 'Codex · Ready' }).click()
  await picker.getByRole('option', { name: /^GPT-5\.5(?! Mini)/ }).click()
  await expect(picker).toHaveCount(0)
  await expect
    .poll(async () => (await calls(page, 'ai_settings_set')).at(-1))
    .toMatchObject({ settings: { active: 'codexCli', codexCli: { model: 'gpt-5.5' } } })
  await expect(panel.getByRole('button', { name: /^Model: GPT-5\.5/ })).toBeVisible()

  await panel.getByRole('button', { name: /^Model:/ }).click()
  const levels = picker.getByRole('group', { name: 'Reasoning' }).getByRole('button')
  await expect(levels).toHaveText(['Default (Medium)', 'Low', 'Medium', 'High'])
  await levels.filter({ hasText: /^High$/ }).click()
  await expect
    .poll(async () => (await calls(page, 'ai_settings_set')).at(-1))
    .toMatchObject({ settings: { codexCli: { model: 'gpt-5.5', reasoning: 'high' } } })
  // A cloud provider's list is asked for only once that provider is opened.
  expect(
    (await calls(page, 'ai_models')).some((c) => (c as any).providers.includes('openai')),
  ).toBe(false)
})

test('search finds models of every provider, and Return picks the first', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'AI')
  await page
    .getByRole('tabpanel')
    .getByRole('button', { name: /^Model:/ })
    .click()
  const picker = page.getByRole('dialog', { name: 'Choose a Model' })
  const search = picker.getByRole('combobox', { name: 'Search all models' })
  await expect(search).toBeFocused()
  await search.fill('mini')
  await expect(picker.getByRole('option')).toHaveText([/GPT-5\.5 Mini/])
  await search.press('Enter')
  await expect
    .poll(async () => (await calls(page, 'ai_settings_set')).at(-1))
    .toMatchObject({ settings: { active: 'codexCli', codexCli: { model: 'gpt-5.5-mini' } } })
})

test('a key is added from Providers and Keys and checked by listing its models', async ({
  page,
}) => {
  await fakeRust(page)
  await openSettings(page, 'AI')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: /^Providers and Keys/ }).click()
  await panel.getByRole('button', { name: 'Add a key for OpenAI-compatible' }).click()
  const sheet = page.getByRole('dialog', { name: 'Add Key for OpenAI-compatible' })
  const key = sheet.getByLabel('API key for OpenAI-compatible')
  await expect(key).toBeFocused()
  await key.fill(SECRET)
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(sheet).toContainText('Key works · 2 models found.')
  await expect(sheet).toContainText('O Large')
  expect(await calls(page, 'ai_key_set')).toEqual([{ provider: 'openai', key: SECRET }])
  expect((await calls(page, 'ai_models')).at(-1)).toEqual({ providers: ['openai'], refresh: true })
  await expect(key).toHaveValue('')
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(
    panel.getByRole('button', { name: 'Change the key for OpenAI-compatible' }),
  ).toBeVisible()
  expect(await page.content()).not.toContain(SECRET)
})

test('Try It answers in the pane under the model', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'AI')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: /^Model:/ }).click()
  await page
    .getByRole('dialog', { name: 'Choose a Model' })
    .getByRole('button', { name: 'Try It' })
    .click()
  await expect(panel).toContainText('Answered in 0.8 s.')
  expect(await calls(page, 'ai_try')).toEqual([
    { provider: 'claudeCli', model: '', reasoning: null },
  ])
})

test('suggestions say why they would not run, and a local tool offers a cloud suggestion model', async ({
  page,
}) => {
  await fakeRust(page, { allowed: 0 })
  await openSettings(page, 'AI')
  const panel = page.getByRole('tabpanel')
  await expect(panel).toContainText('0 of 3 notebooks allow AI access.')
  await panel.getByRole('switch', { name: 'Suggest When I Pause' }).check()
  await expect(panel).toContainText('No suggestions: no notebook allows AI access.')
  await expect(panel).toContainText('A cloud model with a key keeps suggestions quick.')
  await panel.getByRole('button', { name: /^Suggestion Model:/ }).click()
  const picker = page.getByRole('dialog', { name: 'Choose a Model' })
  await expect(picker.getByRole('option').first()).toContainText('Same as Model')
  await picker.getByRole('button', { name: 'Claude (Anthropic) · Needs an API key' }).click()
  await expect(picker).toContainText('Claude (Anthropic) is not set up')
  await expect(picker.getByRole('button', { name: 'Add Key…' })).toBeVisible()
})

test('with nothing set up, the pane lists the tools found on this Mac', async ({ page }) => {
  await fakeRust(page, { codex: 'signedOut', claude: 'notInstalled', active: 'anthropic' })
  await openSettings(page, 'AI')
  const panel = page.getByRole('tabpanel')
  const start = panel.getByRole('region', { name: 'Choose How Devot Reaches AI' })
  await expect(start.getByRole('group', { name: 'Codex' })).toContainText('Sign-in needed')
  await expect(start.getByRole('group', { name: 'Claude Code' })).toContainText('Not installed')
  await expect(panel.getByRole('button', { name: /^Model:/ })).toHaveCount(0)
  await start.getByRole('button', { name: 'Check Codex again' }).click()
  await start.getByRole('button', { name: 'Use Codex' }).click()
  await expect(panel.getByRole('button', { name: /^Model:/ })).toBeVisible()
})

test('a refused change says so and keeps the stored model', async ({ page }) => {
  await fakeRust(page, { refuseSave: 'E_AI_ENDPOINT_INVALID' })
  await openSettings(page, 'AI')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: /^Model:/ }).click()
  await page
    .getByRole('dialog', { name: 'Choose a Model' })
    .getByRole('option', { name: /^Haiku/ })
    .click()
  await expect(page.getByRole('alert')).toHaveText('The AI settings could not be saved.')
  await expect(panel.getByRole('button', { name: /^Model: Default/ })).toBeVisible()
})
