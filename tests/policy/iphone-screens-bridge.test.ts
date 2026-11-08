import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'

// The native screens' bridge (docs/specs/iphone-screens.md, Bridge) is linked only into the iPhone
// app, which CI builds on macOS alone; these checks keep its sides in step on any machine first.

const read = (path: string) => readFileSync(path, 'utf8')
const PACKAGE = 'src-tauri/apple/DevotScreens'
const sources = listFiles('.', `${PACKAGE}/Sources`).filter((file) => file.endsWith('.swift'))
const handWritten = sources.filter((file) => !file.includes('/Generated/'))
const bridge = read(`${PACKAGE}/Sources/DevotScreens/Bridge.swift`)
const rust = read('src-tauri/src/native/ios/screens.rs')

type Signature = { params: string[]; returns: string }

const types = (params: string) =>
  params
    .split(',')
    .map((param) => param.trim())
    .filter(Boolean)
    .map((param) => param.slice(param.indexOf(':') + 1).trim())

function swiftFunctions(): Map<string, Signature> {
  const pattern = /@_cdecl\("(\w+)"\)\s*public func \w+\(([^)]*)\)(?:\s*->\s*(\w+))?/g
  return new Map(
    [...bridge.matchAll(pattern)].map(([, name, params, returns]) => [
      name!,
      { params: types(params!), returns: returns ?? 'Void' },
    ]),
  )
}

function rustFunctions(): Map<string, Signature> {
  const block = /unsafe extern "C" \{([\s\S]*?)\n\}/.exec(rust)?.[1] ?? ''
  const pattern = /fn (\w+)\(([^)]*)\)(?:\s*->\s*(\w+))?;/g
  return new Map(
    [...block.matchAll(pattern)].map(([, name, params, returns]) => [
      name!,
      { params: types(params!), returns: returns ?? '()' },
    ]),
  )
}

// Swift's C types and the Rust types with the same layout.
const SAME_TYPE: Record<string, string> = {
  UInt: 'usize',
  'UnsafePointer<UInt8>?': '*const u8',
  'UnsafeMutableRawPointer?': '*mut c_void',
  DevotScreensCall: 'ScreensCall',
  DevotScreensLog: 'ScreensLog',
  Bool: 'bool',
  Void: '()',
}

it('every C function of the screens package is declared in native/ios/screens.rs with the same types', () => {
  const exported = swiftFunctions()
  const declared = rustFunctions()
  expect([...exported.keys()].sort()).toEqual(['devot_screens_deliver', 'devot_screens_install'])
  expect([...declared.keys()].sort()).toEqual([...exported.keys()].sort())
  for (const [name, signature] of exported) {
    expect({ name, params: signature.params.map((type) => SAME_TYPE[type] ?? type) }).toEqual({
      name,
      params: declared.get(name)?.params,
    })
    expect({ name, returns: SAME_TYPE[signature.returns] }).toEqual({
      name,
      returns: declared.get(name)?.returns,
    })
  }
})

it('the functions Rust hands Swift have the same C types on both sides', () => {
  const flat = bridge.replace(/\s+/g, ' ')
  expect(flat).toContain(
    'typealias DevotScreensReply = @convention(c) (UInt64, UnsafePointer<UInt8>?, UInt) -> Void',
  )
  expect(flat).toContain(
    'typealias DevotScreensCall = @convention(c) ( UInt64, UnsafePointer<UInt8>?, UInt, DevotScreensReply ) -> Void',
  )
  expect(flat).toContain(
    'typealias DevotScreensLog = @convention(c) (UInt8, UnsafePointer<UInt8>?, UInt) -> Void',
  )
  expect(rust).toContain(
    'type ScreensReply = extern "C" fn(request: u64, json: *const u8, len: usize);',
  )
  expect(rust).toContain(
    'type ScreensCall = extern "C" fn(request: u64, json: *const u8, len: usize, reply: ScreensReply);',
  )
  expect(rust).toContain('type ScreensLog = extern "C" fn(level: u8, line: *const u8, len: usize);')
})

it("build.rs leaves each of the screens package's C functions to the iPhone app's link", () => {
  const listed = /const SCREENS_BRIDGE: &\[&str\] = &\[([^\]]*)\]/.exec(read('src-tauri/build.rs'))
  const names = [...(listed?.[1] ?? '').matchAll(/"(\w+)"/g)].map((match) => match[1])
  expect(names.sort()).toEqual([...swiftFunctions().keys()].sort())
})

it('only native/ios/screens.rs declares or calls the bridge', () => {
  const callers = listFiles('.', 'src-tauri/src')
    .filter((file) => file.endsWith('.rs'))
    .filter((file) => /devot_screens_\w+\(/.test(read(file)))
  expect(callers).toEqual(['src-tauri/src/native/ios/screens.rs'])
})

it('keeps raw pointers in Bridge.swift alone', () => {
  expect(handWritten).toContain(`${PACKAGE}/Sources/DevotScreens/Bridge.swift`)
  const withPointers = handWritten.filter((file) => /\bUnsafe\w*Pointer\b/.test(read(file)))
  expect(withPointers).toEqual([`${PACKAGE}/Sources/DevotScreens/Bridge.swift`])
})

it('gives Swift no way into the page but through Rust', () => {
  const files = listFiles('.', 'src-tauri').filter((file) => /\.(swift|rs|m|mm)$/.test(file))
  expect(
    files.filter((file) => /WKScriptMessageHandler|addScriptMessageHandler/.test(read(file))),
  ).toEqual([])
})

it("the page's bridge talks to Rust through ipc.ts and window events only", () => {
  const folder = 'src/renderer/src/phone/screens'
  const files = listFiles('.', folder).filter((file) => /(?<!\.test)\.tsx?$/.test(file))
  expect(files).toContain(`${folder}/bridge.ts`)
  for (const file of files) {
    expect({ file, tauri: /from '@tauri-apps\//.test(read(file)) }).toEqual({ file, tauri: false })
  }
  expect(read(`${folder}/bridge.ts`)).toMatch(/from '\.\.\/\.\.\/ipc'/)
})

it('the iPhone app links the screens package beside the store', () => {
  const project = read('src-tauri/gen/apple/project.yml')
  expect(project).toMatch(/^ {2}DevotScreens:\n {4}path: \.\.\/\.\.\/apple\/DevotScreens$/m)
  expect(project).toMatch(/^ {6}- package: DevotScreens$/m)
  expect(read('src-tauri/gen/apple/devot.xcodeproj/project.pbxproj')).toContain(
    'XCLocalSwiftPackageReference "../../apple/DevotScreens"',
  )
  // Bundle.module, which the generated strings use, exists only for a package with resources.
  const manifest = read(`${PACKAGE}/Package.swift`)
  expect(manifest).toContain('defaultLocalization: "en"')
  expect(manifest).toContain('.process("Generated/Localizable.xcstrings")')
})

it('CI runs the package tests in their host app, over the shared fixtures', () => {
  const script = read('scripts/ci/devot-screens-tests.sh')
  expect(script).toContain('src-tauri/apple/DevotScreens/TestHost')
  expect(script).toContain('xcodebuild test')
  expect(script).toContain('-scheme DevotScreensTests')
  expect(read(`${PACKAGE}/TestHost/project.yml`)).toContain(
    'path: ../../../../tests/fixtures/screens',
  )
})

// The spike harness (docs/specs/iphone-screens.md, Spikes) exists in debug builds only.
const debugOnly = (text: string) => text.replace(/^\s*#if DEBUG\n[\s\S]*?^\s*#endif\n?/gm, '')

it('keeps the spike harness inside #if DEBUG, in Debug/ and in the lines that start it', () => {
  const harness = handWritten.filter((file) => file.includes('/Debug/'))
  expect(harness.length).toBeGreaterThan(0)
  for (const file of harness) {
    expect({ file, inside: debugOnly(read(file)).trim() }).toEqual({ file, inside: '' })
  }
  for (const file of handWritten.filter((path) => !path.includes('/Debug/'))) {
    expect({ file, spike: /Spike/.test(debugOnly(read(file))) }).toEqual({ file, spike: false })
  }
  expect(read(`${PACKAGE}/Sources/DevotScreens/Screens.swift`)).toMatch(
    /#if DEBUG\n\s*SpikeHarness\.startIfAsked\(/,
  )
})

it('lets only the debug harness run script in the page', () => {
  const files = listFiles('.', 'src-tauri').filter((file) => /\.(swift|rs|m|mm)$/.test(file))
  const scripting = files.filter((file) =>
    /callAsyncJavaScript|evaluateJavaScript/.test(read(file)),
  )
  expect(scripting).toEqual([`${PACKAGE}/Sources/DevotScreens/Debug/SpikeHarness.swift`])
  expect(debugOnly(read(scripting[0]!))).not.toMatch(/callAsyncJavaScript|evaluateJavaScript/)
})

it("loads the page's spike probes only in a debug build", () => {
  const folder = 'src/renderer/src'
  const importers = listFiles('.', folder)
    .filter((file) => /(?<!\.test)\.tsx?$/.test(file))
    .filter((file) => /from '\.\/spikes'|import\('\.\/spikes'\)/.test(read(file)))
  expect(importers).toEqual([`${folder}/phone/screens/useSpikes.ts`])
  expect(read(importers[0]!)).toMatch(/if \(!DEVOT_SPIKES\) return\n[\s\S]*import\('\.\/spikes'\)/)
  expect(read(importers[0]!)).not.toMatch(/from '\.\/spikes'/)
})

const quoted = (block: string) =>
  [...block.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]!)

function rustList(path: string, name: string): string[] {
  return quoted(
    new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`).exec(read(path))?.[1] ?? '',
  )
}

function swiftCases(name: string): string[] {
  const swiftText = sources.map(read).join('\n')
  const body =
    new RegExp(`public enum ${name}: String[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(swiftText)?.[1] ?? ''
  return [...body.matchAll(/case (\w+)(?: = "([^"]+)")?/g)].map(([, bare, raw]) => raw ?? bare!)
}

it("Swift names the same operations and notices as Rust and the page, and Rust's direct ones", () => {
  const ops = rustList('src-tauri/src/screens/message.rs', 'OPS')
  expect(ops.length).toBeGreaterThan(0)
  expect(swiftCases('Op')).toEqual(ops)
  const page = /export const SCREENS_OPS = \[([\s\S]*?)\]/.exec(
    read('src/renderer/src/phone/screens/message.ts'),
  )
  expect(quoted(page?.[1] ?? '')).toEqual(ops)
  expect(swiftCases('NoticeKind')).toEqual([
    ...rustList('src-tauri/src/screens/message.rs', 'NOTICES'),
    ...rustList('src-tauri/src/screens/message.rs', 'RUST_NOTICES'),
  ])
  const direct = rustList('src-tauri/src/screens/direct.rs', 'OPS')
  expect(direct.length).toBeGreaterThan(0)
  expect(swiftCases('DirectOp')).toEqual(direct)
})

it('the package tests read the Settings fixtures the page tests read', () => {
  const project = read(`${PACKAGE}/TestHost/project.yml`)
  expect(project).toContain('path: ../../../../tests/fixtures/settings-search.json')
  expect(project).toContain('path: ../../../../tests/fixtures/sync-pane.json')
})

it("the lists' Rust reads know the Templates notebook by the core's ID", () => {
  const core = /TEMPLATES_BOOK_ID = '([^']+)'/.exec(read('src/core/templatesBook.ts'))?.[1]
  const lists = /TEMPLATES_BOOK_ID: &str = "([^"]+)"/.exec(
    read('src-tauri/src/screens/lists.rs'),
  )?.[1]
  expect(core).toBeDefined()
  expect(lists).toBe(core)
})
