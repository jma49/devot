import type { ErrorEvent } from '@sentry/browser'
import { describe, expect, it } from 'vitest'
import { crashEnvironment, scrubEvent } from './crash'

const NOTE = 'buy oat milk'
const TITLE = 'Diary 2026'
const WIDE_TITLE = `${String.fromCodePoint(0x65e5, 0x8a18)} 2026`
const ATTACHMENT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
const SECRET = `Grocery list: ${NOTE}, ${TITLE} ${WIDE_TITLE} /Users/alice/Documents/${TITLE}.md ${ATTACHMENT}`
const SECRETS = [NOTE, TITLE, WIDE_TITLE, 'Grocery list', 'alice', "Alice's MacBook", ATTACHMENT]

function assertNoneLeft(event: unknown) {
  const json = JSON.stringify(event)
  expect(SECRETS.filter((secret) => json.includes(secret))).toEqual([])
}

const secretMap = () => ({ [SECRET]: SECRET, title: TITLE, bytes: ATTACHMENT })

function secretFrame() {
  return {
    function: SECRET,
    module: SECRET,
    filename: `file:///Users/alice/Documents/${TITLE}.md`,
    abs_path: `data:text/javascript;base64,${ATTACHMENT}`,
    lineno: 1,
    colno: 2,
    in_app: true,
    platform: SECRET,
    pre_context: [SECRET],
    context_line: SECRET,
    post_context: [SECRET],
    vars: secretMap(),
    debug_id: SECRET,
    instruction_addr: '0x2079726169',
    module_metadata: secretMap(),
  }
}

/** Every field an event can have, filled with note text, titles, paths that name the user and attachment bytes. */
function poisonedEvent(): ErrorEvent {
  const event = {
    type: undefined,
    event_id: SECRET,
    timestamp: 1,
    level: SECRET,
    platform: SECRET,
    logger: SECRET,
    server_name: "Alice's MacBook",
    release: SECRET,
    dist: SECRET,
    environment: SECRET,
    message: SECRET,
    logentry: { message: SECRET, params: [SECRET] },
    transaction: SECRET,
    fingerprint: [SECRET],
    modules: secretMap(),
    tags: secretMap(),
    extra: secretMap(),
    user: { id: SECRET, username: 'alice', email: SECRET, ip_address: SECRET, data: secretMap() },
    request: { url: `tauri://localhost/?q=${SECRET}`, headers: secretMap(), data: SECRET },
    breadcrumbs: [{ message: SECRET, category: SECRET, data: secretMap() }],
    sdk: {
      name: SECRET,
      version: SECRET,
      integrations: [SECRET],
      packages: [{ name: SECRET, version: SECRET }],
    },
    sdkProcessingMetadata: secretMap(),
    exception: {
      values: [
        {
          type: SECRET,
          value: `E_NOTE_OPEN_FAILED: ${SECRET}`,
          module: SECRET,
          thread_id: SECRET,
          mechanism: {
            type: SECRET,
            handled: false,
            synthetic: true,
            source: SECRET,
            data: secretMap(),
            description: SECRET,
            help_link: SECRET,
          },
          stacktrace: { frames: [secretFrame()], registers: secretMap() },
        },
      ],
    },
    threads: { values: [{ name: SECRET, stacktrace: { frames: [secretFrame()] } }] },
    debug_meta: {
      images: [
        { type: 'sourcemap', debug_id: SECRET, code_file: SECRET },
        { type: 'sourcemap', debug_id: 'c2a8d3f0-1b2c-4d5e-8f90-123456789abc', code_file: SECRET },
        { type: 'macho', debug_id: SECRET, code_file: '/Users/alice/x.dylib' },
      ],
    },
    contexts: {
      device: { name: "Alice's MacBook", arch: SECRET, model: SECRET, family: SECRET },
      os: { name: SECRET, version: SECRET, build: SECRET, kernel_version: SECRET },
      browser: { name: SECRET, version: SECRET },
      app: { app_name: SECRET },
      trace: { trace_id: SECRET },
      note: secretMap(),
    },
  }
  return event as unknown as ErrorEvent
}

describe('scrubEvent', () => {
  it('lets nothing of a note through, whatever the event holds', () => {
    const before = JSON.stringify(poisonedEvent())
    for (const secret of SECRETS) expect(before).toContain(secret)
    assertNoneLeft(scrubEvent(poisonedEvent()))
  })

  it('keeps codes, error types, code locations, release and system details', () => {
    const event = scrubEvent({
      type: undefined,
      event_id: '0123456789abcdef0123456789abcdef',
      timestamp: 1791792731.5,
      level: 'error',
      platform: 'javascript',
      release: 'devot@0.0.0',
      environment: 'production',
      sdk: { name: 'sentry.javascript.browser', version: '11.6.0', integrations: ['Dedupe'] },
      message: `Grocery list: ${NOTE}`,
      exception: {
        values: [
          {
            type: 'TypeError',
            value: `E_NOTE_OPEN_FAILED: ${TITLE}`,
            mechanism: { type: 'auto.browser.global_handlers.onerror', handled: false },
            stacktrace: {
              frames: [
                {
                  function: 'select',
                  filename: 'tauri://localhost/assets/index-a1b2.js?v=3#x',
                  abs_path: 'file:///Users/alice/devot/src/renderer/src/App.tsx',
                  lineno: 12,
                  colno: 3,
                  in_app: true,
                  context_line: `throw new Error("${NOTE}")`,
                },
              ],
            },
          },
          {
            type: 'Error',
            value: `cannot read "${TITLE}"`,
            mechanism: { type: 'chained', source: 'cause', exception_id: 1, parent_id: 0 },
          },
        ],
      },
      contexts: {
        device: { name: "Alice's MacBook", arch: 'arm64', model: 'MacBookPro18,3' },
        os: { name: 'macOS', version: '26.1.0' },
        browser: { name: 'WebKit', version: '621.1.2' },
      },
    })
    expect(event).toEqual({
      type: undefined,
      event_id: '0123456789abcdef0123456789abcdef',
      timestamp: 1791792731.5,
      level: 'error',
      platform: 'javascript',
      release: 'devot@0.0.0',
      environment: 'production',
      sdk: { name: 'sentry.javascript.browser', version: '11.6.0' },
      message: '<redacted>',
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'E_NOTE_OPEN_FAILED',
            mechanism: { type: 'auto.browser.global_handlers.onerror', handled: false },
            stacktrace: {
              frames: [
                {
                  function: 'select',
                  filename: 'tauri://localhost/assets/index-a1b2.js',
                  abs_path: 'file:///Users/<user>/devot/src/renderer/src/App.tsx',
                  lineno: 12,
                  colno: 3,
                  in_app: true,
                },
              ],
            },
          },
          {
            type: 'Error',
            value: '<redacted>',
            mechanism: { type: 'chained', source: 'cause', exception_id: 1, parent_id: 0 },
          },
        ],
      },
      contexts: {
        device: { arch: 'arm64', model: 'MacBookPro18,3' },
        os: { name: 'macOS', version: '26.1.0' },
        browser: { name: 'WebKit', version: '621.1.2' },
      },
    })
  })

  it('keeps the code of a rejection that was not an Error', () => {
    const value = (text: string) =>
      scrubEvent({
        type: undefined,
        exception: { values: [{ type: 'UnhandledRejection', value: text }] },
      }).exception?.values?.[0]?.value
    // A command rejects with its code, as Rust sends it.
    expect(value('Non-Error promise rejection captured with value: E_STORAGE_BUSY')).toBe(
      'E_STORAGE_BUSY',
    )
    expect(value('Non-Error promise rejection captured with value: E_X v13')).toBe('E_X')
    expect(value(`Non-Error promise rejection captured with value: ${TITLE}`)).toBe('<redacted>')
    expect(value(`${TITLE}: Non-Error promise rejection captured with value: E_X`)).toBe(
      '<redacted>',
    )
  })

  it('keeps source map debug IDs so stack traces can be resolved', () => {
    const event = scrubEvent({
      type: undefined,
      exception: {
        values: [
          {
            type: 'TypeError',
            stacktrace: {
              frames: [{ function: 'select', filename: 'file:///Users/alice/devot/assets/a.js' }],
            },
          },
        ],
      },
      debug_meta: {
        images: [
          {
            type: 'sourcemap',
            debug_id: 'c2a8d3f0-1b2c-4d5e-8f90-123456789abc',
            code_file: 'file:///Users/alice/devot/assets/a.js',
          },
          {
            type: 'macho',
            debug_id: '00000000-0000-0000-0000-000000000001',
            image_addr: '0x1000',
            code_file: '/Users/alice/Library/x.dylib',
          },
        ],
      },
    })
    expect(event.debug_meta).toEqual({
      images: [
        {
          type: 'sourcemap',
          debug_id: 'c2a8d3f0-1b2c-4d5e-8f90-123456789abc',
          code_file: 'file:///Users/<user>/devot/assets/a.js',
        },
      ],
    })
    expect(JSON.stringify(event)).not.toContain('alice')
  })
})

describe('crashEnvironment', () => {
  it('names the build as Rust does: development unless Tauri built a release', () => {
    // TAURI_ENV_DEBUG: `tauri dev` and `tauri build --debug` set "true",
    // `tauri build` sets "false"; Rust says development with debug assertions.
    expect(crashEnvironment('true')).toBe('development')
    expect(crashEnvironment('false')).toBe('production')
    expect(crashEnvironment(undefined)).toBe('development')
  })
})
