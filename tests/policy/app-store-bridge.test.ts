import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'

// The StoreKit bridge (docs/adr/0014, The native bridge) is linked only into the iPhone app, which
// CI builds on macOS alone; these checks keep its two sides in step on any machine first.

const read = (path: string) => readFileSync(path, 'utf8')
const PACKAGE = 'src-tauri/apple/DevotStore'
const SOURCES = `${PACKAGE}/Sources/DevotStore`
const swift = readdirSync(SOURCES)
  .filter((name) => name.endsWith('.swift'))
  .map((name) => read(join(SOURCES, name)))
  .join('\n')
const ios = read('src-tauri/src/native/ios.rs')

type Signature = { params: string[]; returns: string }

function swiftFunctions(): Map<string, Signature> {
  const found = new Map<string, Signature>()
  const pattern = /@_cdecl\("(\w+)"\)\s*public func \w+\(([^)]*)\)(?:\s*->\s*(\w+))?/g
  for (const [, name, params, returns] of swift.matchAll(pattern)) {
    found.set(name!, {
      params: split(params!).map((param) => param.slice(param.indexOf(':') + 1).trim()),
      returns: returns ?? 'Void',
    })
  }
  return found
}

function rustFunctions(): Map<string, Signature> {
  const block = /unsafe extern "C" \{([\s\S]*?)\n\}/.exec(ios)?.[1] ?? ''
  const found = new Map<string, Signature>()
  for (const [, name, params, returns] of block.matchAll(
    /fn (\w+)\(([^)]*)\)(?:\s*->\s*(\w+))?;/g,
  )) {
    found.set(name!, {
      params: split(params!).map((param) => param.slice(param.indexOf(':') + 1).trim()),
      returns: returns ?? '()',
    })
  }
  return found
}

function split(params: string): string[] {
  return params
    .split(',')
    .map((param) => param.trim())
    .filter(Boolean)
}

// Swift's C types and the Rust types with the same layout.
const SAME_TYPE: Record<string, string> = {
  UInt64: 'u64',
  UInt: 'usize',
  'UnsafePointer<UInt8>?': '*const u8',
  DevotStoreReply: 'StoreReply',
  DevotStoreUpdate: 'StoreUpdate',
  Bool: 'bool',
  Void: '()',
}

it('every C function of the Swift package is declared in native/ios.rs with the same types', () => {
  const exported = swiftFunctions()
  const declared = rustFunctions()
  expect(exported.size).toBe(7)
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

it("the callbacks' C types match on both sides", () => {
  expect(swift).toContain(
    'typealias DevotStoreReply = @convention(c) (UInt64, UnsafePointer<UInt8>?, UInt) -> Void',
  )
  expect(swift).toContain(
    'typealias DevotStoreUpdate = @convention(c) (UnsafePointer<UInt8>?, UInt) -> Void',
  )
  expect(ios).toContain(
    'type StoreReply = extern "C" fn(request: u64, json: *const u8, len: usize);',
  )
  expect(ios).toContain('type StoreUpdate = extern "C" fn(json: *const u8, len: usize);')
})

it("build.rs leaves each of the Swift package's C functions to the iPhone app's link", () => {
  const listed = /const STORE_BRIDGE: &\[&str\] = &\[([^\]]*)\]/.exec(read('src-tauri/build.rs'))
  const names = [...(listed?.[1] ?? '').matchAll(/"(\w+)"/g)].map((match) => match[1])
  expect(names.sort()).toEqual([...swiftFunctions().keys()].sort())
})

it('only native/ios.rs declares or calls the bridge', () => {
  const callers = listFiles('.', 'src-tauri/src')
    .filter((file) => file.startsWith('src-tauri/src/') && file.endsWith('.rs'))
    .filter((file) => /devot_store_\w+\(/.test(read(file)))
  expect(callers).toEqual(['src-tauri/src/native/ios.rs'])
})

it('Rust, Swift and the StoreKit configuration name the same two products', () => {
  const rust = read('src-tauri/src/app_store/mod.rs')
  const config = JSON.parse(read(`${PACKAGE}/DevotStore.storekit`)) as {
    products: { productID: string; type: string; familyShareable: boolean }[]
  }
  const ids = ['io.github.jma49.devot.pro', 'io.github.jma49.devot.trial']
  for (const id of ids) {
    expect(rust).toContain(`"${id}"`)
    expect(swift).toContain(`"${id}"`)
  }
  expect(config.products.map((product) => product.productID).sort()).toEqual(ids)
  // Family Sharing is off for both (ADR 0014, Threat model).
  for (const product of config.products) {
    expect(product).toMatchObject({ type: 'NonConsumable', familyShareable: false })
  }
})

it('the iPhone app links the Swift package and the Mac build has no Swift', () => {
  const project = read('src-tauri/gen/apple/project.yml')
  expect(project).toMatch(/^packages:\n {2}DevotStore:\n {4}path: \.\.\/\.\.\/apple\/DevotStore$/m)
  expect(project).toMatch(/^ {6}- package: DevotStore$/m)
  expect(read('src-tauri/gen/apple/devot.xcodeproj/project.pbxproj')).toContain(
    'XCLocalSwiftPackageReference "../../apple/DevotStore"',
  )
  for (const file of ['src-tauri/tauri.conf.json', 'src-tauri/build.rs', 'src-tauri/Cargo.toml']) {
    expect({ file, swift: /DevotStore|swiftc|\.swift\b/.test(read(file)) }).toEqual({
      file,
      swift: false,
    })
  }
})

it('no log or error in the App Store code can carry a JWS', () => {
  const files = [
    ...readdirSync('src-tauri/src/app_store').map((name) => `src-tauri/src/app_store/${name}`),
    'src-tauri/src/native/ios.rs',
  ]
  const logs = files.flatMap((file) =>
    read(file)
      .split('\n')
      .filter((line) => /\b(log::\w+!|eprintln!|println!|dbg!)/.test(line))
      .map((line) => `${file}: ${line.trim()}`),
  )
  expect(logs.filter((line) => /jws|transaction\b|json/i.test(line))).toEqual([])
  expect(swift).not.toMatch(/\bprint\(|NSLog|os_log|Logger\(/)
})
