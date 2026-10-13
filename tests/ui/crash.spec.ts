import type { Page } from '@playwright/test'
import { expect, test, type IpcCall, type TestWindow } from './fixtures'

// A DSN for a host that the test intercepts; nothing leaves the machine.
const DSN = 'https://public@o1.ingest.us.sentry.io/1'

/** Starts crash reporting in the page; returns what reaches "Sentry". */
async function startSentry(page: Page): Promise<string[]> {
  const sent: string[] = []
  await page.route('https://o1.ingest.us.sentry.io/**', async (route) => {
    sent.push(route.request().postData() ?? '')
    await route.fulfill({ status: 200, body: '{}' })
  })
  await page.goto('/')
  await page.addScriptTag({
    type: 'module',
    content: `
      const { startCrashReporting } = await import('/src/crash.ts')
      await startCrashReporting('${DSN}', 'devot@test')
      document.documentElement.dataset['crashReporting'] = 'on'
    `,
  })
  await expect(page.locator('html[data-crash-reporting="on"]')).toHaveCount(1)
  return sent
}

const logged = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as TestWindow).devotIpcCalls
      .filter((c: IpcCall) => c.cmd === 'log_write')
      .map((c: IpcCall) => c.args),
  )

test('an uncaught error reaches Sentry scrubbed of note content', async ({ page }) => {
  const sent = await startSentry(page)
  await page.addScriptTag({
    type: 'module',
    content: `
      setTimeout(() => {
        throw new Error(
          'E_UI_CRASH_TEST: Diary 2026 buy oat milk /Users/alice/Documents/Diary 2026.md ' +
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        )
      })
    `,
  })
  await expect.poll(() => sent.join('\n')).toContain('E_UI_CRASH_TEST')
  const envelope = sent.join('\n')
  expect(envelope).toContain('devot@test')
  // The page was not built by Tauri's CLI as a release.
  expect(envelope).toContain('"environment":"development"')
  for (const secret of ['Diary 2026', 'oat milk', '/Users/alice', 'iVBORw0KGgo']) {
    expect(envelope).not.toContain(secret)
  }
})

test('a command that fails unhandled reaches the log and Sentry with its code', async ({
  page,
}) => {
  const sent = await startSentry(page)
  // Rust rejects with its code as a string, and more after it.
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { backup_restore: { error: 'E_STORAGE_SCHEMA_TOO_NEW v13' } }
  })
  await page.addScriptTag({
    type: 'module',
    content: `
      const { invoke } = await import('/src/ipc.ts')
      setTimeout(() => void invoke('backup_restore', { id: 'x' }))
    `,
  })
  await expect.poll(() => sent.join('\n')).toContain('"value":"E_STORAGE_SCHEMA_TOO_NEW"')
  await expect
    .poll(() => logged(page))
    .toContainEqual({
      level: 'error',
      code: 'E_UI_UNHANDLED_REJECTION',
      ids: ['E_STORAGE_SCHEMA_TOO_NEW'],
    })
})

test('a rejection that is not an Error keeps its code in Sentry', async ({ page }) => {
  const sent = await startSentry(page)
  await page.addScriptTag({
    type: 'module',
    content: `setTimeout(() => void Promise.reject('E_STORAGE_BUSY'))`,
  })
  await expect.poll(() => sent.join('\n')).toContain('"value":"E_STORAGE_BUSY"')
})
