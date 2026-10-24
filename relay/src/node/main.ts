import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { validSecret } from '../tokens.ts'
import { startNodeRelay } from './server.ts'

// `node relay/src/node/main.ts`: RELAY_SECRET (required), RELAY_DATA (the
// vaults' folder, default ./relay-data), PORT (default 8787), HOST (default
// 127.0.0.1: put a TLS proxy in front, docs/sync-relay.md).

const secret = process.env['RELAY_SECRET']
if (!validSecret(secret)) {
  console.error('E_RELAY_CONFIG RELAY_SECRET must be at least 32 characters')
  process.exit(1)
}
const data = resolve(process.env['RELAY_DATA'] ?? 'relay-data')
mkdirSync(data, { recursive: true })
const relay = await startNodeRelay({
  data,
  secret,
  port: Number(process.env['PORT'] ?? 8787),
  host: process.env['HOST'] ?? '127.0.0.1',
})
console.log(`I_RELAY_LISTENING ${relay.url}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void relay.close().then(() => process.exit(0)))
}
