import { fileURLToPath } from 'node:url'
import { publicKeyFromSeed, toBase64Url } from '../src/format.ts'

// Prints a new signing key pair for the owner (docs/licensing.md, Signing keys). Nothing is written
// to disk: the seed goes into the Wrangler secret and an offline copy, the public key into the app.

export async function generateKeyPair(): Promise<{ seed: string; publicKey: string }> {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  return { seed: toBase64Url(seed), publicKey: toBase64Url(await publicKeyFromSeed(seed)) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { seed, publicKey } = await generateKeyPair()
  process.stdout.write(
    [
      `LICENCE_SIGNING_KEY (Wrangler secret; keep an offline copy): ${seed}`,
      `Public key (ships in the app under this key's kid): ${publicKey}`,
      '',
    ].join('\n'),
  )
}
