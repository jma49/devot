import type { Page } from '@playwright/test'
import { expect, openSettings, test, type TestWindow } from './fixtures'

// Settings > AI. Rust is faked in the page: it keeps the settings and says
// only whether a key is stored, as the real commands do.

const SECRET = 'sk-test-0123456789'

async function fakeRust(page: Page, failing?: string, storedKey = 'unset') {
  await page.addInitScript(
    ([failure, initial]) => {
      const w = globalThis as unknown as TestWindow
      const provider = (endpoint: string, model: string, defaultModel: string) => ({
        endpoint,
        model,
        defaultEndpoint: endpoint,
        defaultModel,
        key: initial,
      })
      const state: Record<string, any> = {
        active: 'anthropic',
        anthropic: provider('https://api.anthropic.com', 'claude-sonnet-5-5', 'claude-sonnet-5-5'),
        openai: provider('https://api.openai.com/v1', '', ''),
      }
      const copy = () => JSON.parse(JSON.stringify(state))
      w.devotIpcMocks = {
        ai_settings_get: () => copy(),
        ai_settings_set: (args: { settings: Record<string, any> }) => {
          if (failure) throw failure
          for (const id of ['anthropic', 'openai']) {
            state[id].endpoint = args.settings[id].endpoint
            state[id].model = args.settings[id].model
          }
          state['active'] = args.settings['active']
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
      }
    },
    [failing, storedKey] as const,
  )
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((call) => call.cmd === c)
        .map((call) => call.args),
    cmd,
  )

test('shows Claude as the active provider with its defaults', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'AI')
  const panel = page.getByRole('tabpanel')
  await expect(panel).toContainText('only when you start an AI action')
  await expect(panel.getByRole('combobox', { name: 'Provider' })).toHaveValue('anthropic')
  const claude = panel.getByRole('region', { name: 'Claude (Anthropic)' })
  await expect(claude.getByRole('textbox', { name: 'Endpoint' })).toHaveValue(
    'https://api.anthropic.com',
  )
  await expect(claude.getByRole('textbox', { name: 'Model' })).toHaveValue('claude-sonnet-5-5')
  await expect(claude).toContainText('No key is stored.')
  const other = panel.getByRole('region', { name: 'OpenAI-compatible' })
  await expect(other).toContainText('The name of the model to ask on this server.')
})

test('picks the active provider and saves an endpoint and a model on leaving the field', async ({
  page,
}) => {
  await fakeRust(page)
  await openSettings(page, 'AI')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('combobox', { name: 'Provider' }).selectOption('openai')
  await expect.poll(async () => (await calls(page, 'ai_settings_set')).length).toBe(1)

  const other = panel.getByRole('region', { name: 'OpenAI-compatible' })
  await other.getByRole('textbox', { name: 'Endpoint' }).fill('http://localhost:11434/v1')
  // Moving on to the next field stores the endpoint; Return stores the model.
  await other.getByRole('textbox', { name: 'Model' }).fill('llama3.2:3b')
  await other.getByRole('textbox', { name: 'Model' }).press('Enter')
  await expect.poll(async () => (await calls(page, 'ai_settings_set')).length).toBe(3)
  expect((await calls(page, 'ai_settings_set')).at(-1)).toEqual({
    settings: {
      active: 'openai',
      anthropic: { endpoint: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
      openai: { endpoint: 'http://localhost:11434/v1', model: 'llama3.2:3b' },
    },
  })
  await expect(panel.getByRole('combobox', { name: 'Provider' })).toHaveValue('openai')
  // Leaving a field that did not change stores nothing.
  await other.getByRole('textbox', { name: 'Model' }).focus()
  await other.getByRole('textbox', { name: 'Endpoint' }).focus()
  await page.getByRole('combobox', { name: 'Provider' }).focus()
  expect(await calls(page, 'ai_settings_set')).toHaveLength(3)
})

test('a key goes to Rust, is cleared from the page and can be removed', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'AI')
  const claude = page.getByRole('region', { name: 'Claude (Anthropic)' })
  const field = claude.getByLabel('API key for Claude (Anthropic)')
  const save = claude.getByRole('button', { name: 'Save Key' })
  const remove = claude.getByRole('button', { name: 'Remove Key' })
  await expect(save).toBeDisabled()
  await expect(remove).toBeDisabled()

  await field.fill(SECRET)
  await save.click()
  await expect(claude).toContainText('A key is stored in the Keychain.')
  await expect(field).toHaveValue('')
  await expect(page.getByRole('tabpanel').getByRole('status')).toHaveText(
    'The Claude (Anthropic) key was saved.',
  )
  expect(await calls(page, 'ai_key_set')).toEqual([{ provider: 'anthropic', key: SECRET }])
  // Nothing of the key stays in the page.
  expect(await page.content()).not.toContain(SECRET)
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(SECRET)

  await remove.click()
  await expect(claude).toContainText('No key is stored.')
  expect(await calls(page, 'ai_key_clear')).toEqual([{ provider: 'anthropic' }])
})

test('a refused change shows its code and puts the stored values back', async ({ page }) => {
  await fakeRust(page, 'E_AI_ENDPOINT_INVALID')
  await openSettings(page, 'AI')
  const claude = page.getByRole('region', { name: 'Claude (Anthropic)' })
  const endpoint = claude.getByRole('textbox', { name: 'Endpoint' })
  await endpoint.fill('http://example.com')
  await endpoint.press('Enter')
  await expect(page.getByRole('alert')).toHaveText(
    'The AI settings could not be saved (E_AI_ENDPOINT_INVALID).',
  )
  await expect(endpoint).toHaveValue('https://api.anthropic.com')
})

test('a keychain that cannot be read still lets a key be replaced or removed', async ({ page }) => {
  await fakeRust(page, undefined, 'unknown')
  await openSettings(page, 'AI')
  const claude = page.getByRole('region', { name: 'Claude (Anthropic)' })
  await expect(claude).toContainText('The Keychain could not be read.')
  const field = claude.getByLabel('API key for Claude (Anthropic)')
  await expect(field).toBeEnabled()
  await field.fill(SECRET)
  await expect(claude.getByRole('button', { name: 'Save Key' })).toBeEnabled()
  await claude.getByRole('button', { name: 'Remove Key' }).click()
  await expect(claude).toContainText('No key is stored.')
})
