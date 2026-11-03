// Builds dist-mcp-helper/devot-mcp, the MCP server inside Devot.app (docs/architecture.md, Setup
// helper): a Node single executable of a pinned, checksummed Node, so neither the app's users nor
// this build depend on the Node installed here. Its better-sqlite3 calls run on Node's own SQLite.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inject } from 'postject'
import { build } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const NODE_VERSION = 'v24.22.2'
const NODE_ARCHIVES: Record<string, { platform: string; sha256: string }> = {
  arm64: {
    platform: 'darwin-arm64',
    sha256: 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
  },
  x64: {
    platform: 'darwin-x64',
    sha256: 'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52',
  },
}
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
// V8 cannot JIT under the hardened runtime without an entitlement, which the app has none of
// (docs/releasing.md); and an MCP client's environment must not add flags to the helper.
const SEA_CONFIG = {
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  execArgv: ['--jitless', '--disable-warning=ExperimentalWarning'],
  execArgvExtension: 'none',
}

async function pinnedNode(): Promise<string> {
  const archive = NODE_ARCHIVES[process.arch]
  if (process.platform !== 'darwin' || !archive) throw new Error('E_MCP_HELPER_PLATFORM')
  const name = `node-${NODE_VERSION}-${archive.platform}`
  const cache = join(ROOT, 'node_modules/.cache/devot-mcp-helper', name)
  const node = join(cache, 'node')
  if (existsSync(node)) return node
  const response = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/${name}.tar.gz`)
  if (!response.ok) throw new Error('E_MCP_HELPER_NODE_DOWNLOAD')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== archive.sha256) {
    throw new Error('E_MCP_HELPER_NODE_CHECKSUM')
  }
  mkdirSync(cache, { recursive: true })
  const tarball = join(cache, 'node.tar.gz')
  writeFileSync(tarball, bytes)
  execFileSync('tar', ['-xzf', tarball, '-C', cache, '--strip-components=2', `${name}/bin/node`])
  rmSync(tarball)
  return node
}

/** Builds the helper in `outDir` and returns its path, signed ad hoc with the hardened runtime. */
export async function buildHelper(outDir = join(ROOT, 'dist-mcp-helper')): Promise<string> {
  const node = await pinnedNode()
  await build({
    configFile: join(ROOT, 'vite.mcp-helper.config.ts'),
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
  })
  const main = join(outDir, 'devot-mcp.cjs')
  const blob = join(outDir, 'devot-mcp.blob')
  const config = join(outDir, 'sea.json')
  writeFileSync(config, JSON.stringify({ ...SEA_CONFIG, main, output: blob }))
  execFileSync(node, ['--experimental-sea-config', config], { stdio: 'ignore' })

  const helper = join(outDir, 'devot-mcp')
  copyFileSync(node, helper)
  chmodSync(helper, 0o755)
  execFileSync('codesign', ['--remove-signature', helper])
  execFileSync('strip', ['-x', helper])
  await inject(helper, 'NODE_SEA_BLOB', readFileSync(blob), {
    sentinelFuse: SEA_FUSE,
    machoSegmentName: 'NODE_SEA',
  })
  execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', helper], {
    stdio: 'ignore',
  })
  for (const made of [main, blob, config]) rmSync(made)

  const checked = execFileSync(helper, ['--self-check'], { encoding: 'utf8' })
  if (!checked.startsWith('ok ')) throw new Error('E_MCP_HELPER_SELF_CHECK')
  return helper
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2]
  const helper = await buildHelper(out ? resolve(out) : undefined)
  process.stdout.write(`${helper}\n`)
}
