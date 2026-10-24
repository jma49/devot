import type { Page } from '@playwright/test'
import { expect, openApp, test, type TestWindow } from './fixtures'
import { pluginFrame, servePlugins, testPlugin } from './plugins'

// The malicious-plugin suite (ADR 0005): code in a plugin's frame tries what a hostile plugin would, and reaches neither Tauri,
// the main window, another plugin, the network, nor a note it was not granted. The attacks run in the plugin's own page
// (Playwright evaluates in that frame, as the plugin's script would run).

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')

const savedBody = (page: Page) =>
  page.evaluate(
    () =>
      (JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as { bodyMd: string }[])[0]
        ?.bodyMd,
  )

// Keeps the port the host hands in (any listener in the page gets it), to speak the protocol without Devot's runtime.
const PROBE = `
addEventListener('message', (event) => {
  if (!event.ports[0] || globalThis.stolen) return
  globalThis.stolen = event.ports[0]
  globalThis.answers = []
  event.ports[0].addEventListener('message', (m) => globalThis.answers.push(m.data))
})
devot.commands.handle('probe', () => null)
globalThis.evaluated = [() => eval('1 + 1'), () => new Function('return 2')()].map((run) => {
  try {
    run()
    return 'ran'
  } catch {
    return 'blocked'
  }
})
`

const VICTIM = `
devot.commands.handle('read', async () => {
  const note = await devot.note.read()
  globalThis.read = note.markdown
})
`

const probe = testPlugin(
  'com.example.probe',
  ['commands'],
  { commands: [{ id: 'probe', title: 'Probe' }] },
  PROBE,
)
const victim = testPlugin(
  'com.example.victim',
  ['note.read', 'commands'],
  { commands: [{ id: 'read', title: 'Read Note' }] },
  VICTIM,
  { files: { 'secret.js': 'globalThis.victimSecret = 1' } },
)

const network: string[] = []

test.beforeEach(async ({ page }) => {
  network.length = 0
  await page.context().route('https://example.com/**', (route) => {
    network.push(route.request().url())
    return route.fulfill({ status: 204, body: '' })
  })
  await servePlugins(page, [probe, victim])
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await body(page).click()
  await page.keyboard.insertText('private text')
  await expect.poll(() => savedBody(page)).toBe('private text')
})

const runCommand = async (page: Page, title: string) => {
  await page.keyboard.press('Meta+KeyK')
  const field = page.getByRole('combobox', { name: 'Command Palette' })
  await field.fill(`> ${title}`)
  await page
    .getByRole('dialog', { name: 'Command Palette' })
    .getByRole('option', { name: new RegExp(title) })
    .first()
    .click()
}

test('runs each plugin in its own sandboxed frame with an opaque origin, never in the main window', async ({
  page,
}) => {
  const frame = await pluginFrame(page, 'com.example.probe')
  expect(await frame.evaluate(() => origin)).toBe('null')
  const container = frame.parentFrame()!
  expect(await container.evaluate(() => origin)).toBe('null')
  expect(container.parentFrame()).toBe(page.mainFrame())
  expect(await page.evaluate(() => typeof (globalThis as { devot?: unknown }).devot)).toBe(
    'undefined',
  )
  const outer = page.locator('iframe.plugin-frame[data-plugin="com.example.probe"]')
  await expect(outer).toHaveAttribute('sandbox', 'allow-scripts')
  // Nor run code from text (the plugin's own script tried as it loaded).
  expect(await frame.evaluate(() => (globalThis as { evaluated?: unknown }).evaluated)).toEqual([
    'blocked',
    'blocked',
  ])
})

test('cannot reach Tauri or the main window', async ({ page }) => {
  const frame = await pluginFrame(page, 'com.example.probe')
  const before = await page.evaluate(
    () => (globalThis as unknown as TestWindow).devotIpcCalls.length,
  )
  const reached = await frame.evaluate(() => {
    const g = globalThis as Record<string, unknown>
    const tries: Record<string, string> = {}
    const attempt = (name: string, run: () => unknown) => {
      try {
        const value = run()
        tries[name] = value === undefined ? 'undefined' : 'reached'
      } catch {
        tries[name] = 'blocked'
      }
    }
    attempt('own internals', () => g['__TAURI_INTERNALS__'])
    attempt('own ipc', () => g['ipc'])
    attempt(
      'top internals',
      () => (top as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'],
    )
    attempt('top document', () => top!.document.title)
    attempt('container document', () => parent.document.title)
    attempt('top storage', () => (top as Window).localStorage.getItem('devot.test.notes'))
    attempt('own storage', () => localStorage.getItem('x'))
    attempt('cookies', () => document.cookie.length || undefined)
    // A message to the main window as if it were Tauri's or the host's.
    top!.postMessage({ cmd: 'notes_list', callback: 1, error: 2 }, '*')
    top!.postMessage({ devot: 1, kind: 'call', seq: 1, method: 'note.read' }, '*')
    return tries
  })
  expect(reached).toEqual({
    'own internals': 'undefined',
    'own ipc': 'undefined',
    'top internals': 'blocked',
    'top document': 'blocked',
    'container document': 'blocked',
    'top storage': 'blocked',
    'own storage': 'blocked',
    cookies: 'blocked',
  })
  await page.waitForTimeout(200)
  const after = await page.evaluate(() =>
    (globalThis as unknown as TestWindow).devotIpcCalls.slice(0).map((c) => c.cmd),
  )
  expect(after.slice(before).filter((cmd) => cmd !== 'log_write')).toEqual([])
})

test('cannot reach the network, by any request or by navigating', async ({ page }) => {
  const frame = await pluginFrame(page, 'com.example.probe')
  const outcomes = await frame.evaluate(async () => {
    const out: Record<string, string> = {}
    const settle = async (name: string, run: () => Promise<unknown>) => {
      try {
        await run()
        out[name] = 'reached'
      } catch {
        out[name] = 'blocked'
      }
    }
    await settle('fetch', () => fetch('https://example.com/fetch'))
    await settle('fetch app', () => fetch(`${location.origin}/`))
    await settle(
      'xhr',
      () =>
        new Promise((resolve, reject) => {
          const x = new XMLHttpRequest()
          x.onload = resolve
          x.onerror = reject
          try {
            x.open('GET', 'https://example.com/xhr')
            x.send()
          } catch (e) {
            reject(e)
          }
        }),
    )
    await settle(
      'websocket',
      () =>
        new Promise((resolve, reject) => {
          try {
            const ws = new WebSocket('wss://example.com/ws')
            ws.onopen = resolve
            ws.onerror = reject
          } catch (e) {
            reject(e)
          }
        }),
    )
    await settle(
      'image',
      () =>
        new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = resolve
          img.onerror = reject
          img.src = 'https://example.com/pixel.png'
        }),
    )
    // Queued or not, the policy stops it: no request reaches the network (below).
    navigator.sendBeacon('https://example.com/beacon', 'x')
    out['webrtc'] = typeof (globalThis as Record<string, unknown>)['RTCPeerConnection']
    out['window.open'] = window.open('https://example.com/popup') === null ? 'blocked' : 'reached'
    const form = document.createElement('form')
    form.action = 'https://example.com/form'
    document.body.append(form)
    form.submit()
    const frameOf = document.createElement('iframe')
    frameOf.src = 'https://example.com/frame'
    try {
      document.body.append(frameOf)
    } catch {
      // Refused by the runtime; the policy would stop it anyway.
    }
    location.href = 'https://example.com/?leak=1'
    return out
  })
  expect(outcomes).toEqual({
    fetch: 'blocked',
    'fetch app': 'blocked',
    xhr: 'blocked',
    websocket: 'blocked',
    image: 'blocked',
    webrtc: 'undefined',
    'window.open': 'blocked',
  })
  await page.waitForTimeout(500)
  expect(network).toEqual([])
  // The plugin's page is still where it was: the navigation never left.
  expect(page.frames().some((f) => f.url().startsWith('https://example.com'))).toBe(false)
})

test('cannot make a frame of its own, whose fresh global would bring WebRTC back', async ({
  page,
}) => {
  const frame = await pluginFrame(page, 'com.example.probe')
  const outcomes = await frame.evaluate(async () => {
    const out: Record<string, string> = {}
    const attempt = (name: string, run: () => unknown) => {
      try {
        run()
        out[name] = 'made'
      } catch (e) {
        out[name] = e instanceof DOMException ? e.message : 'failed'
      }
    }
    attempt('append', () => document.body.append(document.createElement('iframe')))
    attempt('appendChild', () => document.body.appendChild(document.createElement('iframe')))
    attempt('innerHTML', () => {
      document.body.innerHTML = '<div><iframe></iframe></div>'
    })
    attempt('insertAdjacentHTML', () =>
      document.body.insertAdjacentHTML(
        'beforeend',
        '<svg><foreignObject><iframe></iframe></foreignObject></svg>',
      ),
    )
    attempt('fragment', () => {
      const t = document.createElement('template')
      t.innerHTML = '<iframe srcdoc="x"></iframe>'
      document.body.append(t.content)
    })
    attempt('range', () =>
      document.body.append(document.createRange().createContextualFragment('<object></object>')),
    )
    attempt('frameset', () => {
      const set = document.createElement('frameset')
      set.innerHTML = '<frame>'
      document.body.append(set)
    })
    attempt('write', () => document.write('<iframe></iframe>'))
    attempt('shadow', () => document.body.attachShadow({ mode: 'closed' }))
    attempt('hint', () => {
      const link = document.createElement('link')
      link.rel = 'dns-prefetch'
      link.href = 'https://leak.example.com'
      document.head.append(link)
    })
    const late = document.createElement('link')
    late.href = 'https://leak.example.com'
    document.head.append(late)
    late.rel = 'preconnect'
    await new Promise((resolve) => setTimeout(resolve, 50))
    out['late hint'] = late.isConnected ? 'kept' : 'removed'
    out['frames'] = String(
      window.length + document.querySelectorAll('iframe, frame, object').length,
    )
    const loose = document.createElement('iframe')
    out['contentWindow'] = String(loose.contentWindow)
    return out
  })
  const refused = 'E_PLUGIN_FRAME_BLOCKED'
  expect(outcomes).toEqual({
    append: refused,
    appendChild: refused,
    innerHTML: refused,
    insertAdjacentHTML: refused,
    fragment: refused,
    range: refused,
    frameset: refused,
    write: refused,
    shadow: refused,
    hint: refused,
    'late hint': 'removed',
    frames: '0',
    contentWindow: 'null',
  })
  await page.waitForTimeout(300)
  expect(network).toEqual([])
})

test('cannot reach another plugin, its files or its port', async ({ page }) => {
  const frame = await pluginFrame(page, 'com.example.probe')
  await pluginFrame(page, 'com.example.victim')
  const outcomes = await frame.evaluate(async () => {
    const out: Record<string, string> = {}
    const loaded = (src: string) =>
      new Promise<string>((resolve) => {
        const s = document.createElement('script')
        s.src = src
        s.onload = () => resolve('reached')
        s.onerror = () => resolve('blocked')
        document.head.append(s)
      })
    const victimBase = location.href.replace(
      'com.example.probe/__devot/frame.html',
      'com.example.victim/',
    )
    out['script'] = await loaded(`${victimBase}secret.js`)
    out['fetch'] = await fetch(`${victimBase}main.js`).then(
      () => 'reached',
      () => 'blocked',
    )
    // Every frame of the main window: none can be read.
    const windows = top!.frames
    let readable = 0
    for (let i = 0; i < windows.length; i += 1) {
      try {
        void windows[i]!.document.title
        readable += 1
      } catch {
        // Cross-origin.
      }
      if (windows[i]!.frames[0] === window) continue
      try {
        void windows[i]!.frames[0]!.document.title
        readable += 1
      } catch {
        // Cross-origin.
      }
    }
    out['frames read'] = String(readable)
    // A port handed to every plugin page as if from its container: each takes a port from its own parent only.
    for (let i = 0; i < windows.length; i += 1) {
      const channel = new MessageChannel()
      windows[i]!.frames[0]?.postMessage({ devot: 1, kind: 'connect' }, '*', [channel.port2])
    }
    return out
  })
  expect(outcomes).toEqual({ script: 'blocked', fetch: 'blocked', 'frames read': '0' })
  // The other plugin ignored the strangers and still talks to the host alone: its command reads the note.
  const victimFrame = await pluginFrame(page, 'com.example.victim')
  await runCommand(page, 'Read Note')
  await expect
    .poll(() => victimFrame.evaluate(() => (globalThis as { read?: string }).read))
    .toBe('private text')
  expect(
    await victimFrame.evaluate(() => (globalThis as { victimSecret?: number }).victimSecret),
  ).toBeUndefined()
})

test('cannot read or change a note without its permission, nor call anything the protocol lacks', async ({
  page,
}) => {
  const frame = await pluginFrame(page, 'com.example.probe')
  await runCommand(page, 'Probe')
  const answers = await frame.evaluate(async () => {
    const g = globalThis as unknown as {
      devot: { note: { read(): Promise<unknown>; replace(e: unknown): Promise<unknown> } }
    }
    const codeOf = (p: Promise<unknown>) =>
      p.then(
        () => 'allowed',
        (e: { code?: string }) => e.code ?? 'failed',
      )
    return {
      read: await codeOf(g.devot.note.read()),
      replace: await codeOf(g.devot.note.replace({ base: 'private text', markdown: 'stolen' })),
    }
  })
  expect(answers).toEqual({
    read: 'E_PLUGIN_PERMISSION_DENIED',
    replace: 'E_PLUGIN_PERMISSION_DENIED',
  })
  const raw = await frame.evaluate(async () => {
    const g = globalThis as unknown as {
      stolen: MessagePort
      answers: { seq: number; code?: string }[]
    }
    const send = (seq: number, method: string, params?: unknown) =>
      g.stolen.postMessage({ devot: 1, kind: 'call', seq, method, params })
    send(901, 'invoke', { cmd: 'notes_list' })
    send(902, 'plugin_install_confirm', { token: 1 })
    send(903, 'note.read', undefined)
    send(904, 'note.replace', {
      base: 'private text',
      markdown: 'stolen',
      plugin: 'com.example.victim',
    })
    await new Promise((r) => setTimeout(r, 300))
    return g.answers.filter((a) => a.seq > 900).map((a) => [a.seq, a.code])
  })
  expect(raw).toEqual([
    [901, 'E_PLUGIN_METHOD_UNKNOWN'],
    [902, 'E_PLUGIN_METHOD_UNKNOWN'],
    [903, 'E_PLUGIN_PERMISSION_DENIED'],
    [904, 'E_PLUGIN_PERMISSION_DENIED'],
  ])
  await expect(body(page)).toHaveText('private text')
  expect(await savedBody(page)).toBe('private text')
})

test('reads the note only while one of its commands runs, even with the permission', async ({
  page,
}) => {
  const frame = await pluginFrame(page, 'com.example.victim')
  const code = await frame.evaluate(() =>
    (globalThis as unknown as { devot: { note: { read(): Promise<unknown> } } }).devot.note
      .read()
      .then(
        () => 'allowed',
        (e: { code?: string }) => e.code,
      ),
  )
  expect(code).toBe('E_PLUGIN_NOT_ACTIVE')
})
