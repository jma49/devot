import { fileURLToPath } from 'node:url'
import { fromBase64Url, instant, newLicenceId, signerFromSeed, signLicence } from '../src/format.ts'

// Signs a complimentary licence on the owner's machine (docs/licensing.md, Complimentary
// licences): the seed and its kid come from the environment, the licensee from the argument. It
// prints the key and writes nothing; D1 never hears of it, so only `issue` itself made it.

export interface Issued {
  id: string
  key: string
}

export async function issue(options: {
  seed: string
  kid: string
  licensee: string
  now: Date
}): Promise<Issued> {
  const seed = fromBase64Url(options.seed)
  if (seed?.length !== 32) throw new Error('E_LICENCE_CONFIG')
  const signer = await signerFromSeed(options.kid, seed)
  const id = newLicenceId()
  const key = await signLicence(signer, {
    id,
    licensee: options.licensee,
    issuedAt: instant(options.now),
  })
  return { id, key }
}

const USAGE =
  'Usage: LICENCE_SIGNING_KEY=… LICENCE_KID=… pnpm --filter @devot/licence issue <email>'

/** The command: its exit status; the key goes to `out`, problems (codes only) to `err`. */
export async function main(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: (text: string) => void,
  err: (text: string) => void,
  now = new Date(),
): Promise<number> {
  const licensee = args[0]?.trim() ?? ''
  const seed = env['LICENCE_SIGNING_KEY'] ?? ''
  const kid = env['LICENCE_KID'] ?? ''
  if (args.length !== 1 || licensee === '' || !licensee.includes('@')) {
    err(`E_LICENCE_BAD_REQUEST\n${USAGE}\n`)
    return 2
  }
  if (seed === '' || kid === '') {
    err(`E_LICENCE_CONFIG\n${USAGE}\n`)
    return 2
  }
  try {
    const issued = await issue({ seed, kid, licensee, now })
    out(
      [
        `Licence ID: ${issued.id}`,
        `Key: ${issued.key}`,
        `Open in Devot: devot://licence?key=${encodeURIComponent(issued.key)}`,
        '',
      ].join('\n'),
    )
    return 0
  } catch {
    err(`E_LICENCE_CONFIG\n${USAGE}\n`)
    return 2
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(
    process.argv.slice(2),
    process.env,
    (text) => process.stdout.write(text),
    (text) => process.stderr.write(text),
  )
}
