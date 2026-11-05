import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  fromBase64Url,
  instant,
  LICENCE_ID,
  newLicenceId,
  signerFromSeed,
  signLicence,
} from '../src/format.ts'

// Signs a complimentary licence on the owner's machine (docs/licensing.md, Complimentary
// licences): the seed and its kid come from the environment, the licensee from the argument, and
// `--id` renews a licence under the ID it already has. It prints the key and writes nothing; D1
// never hears of it, so only `issue` itself made it.

export interface Issued {
  id: string
  key: string
}

export async function issue(options: {
  seed: string
  kid: string
  licensee: string
  now: Date
  id?: string
}): Promise<Issued> {
  const seed = fromBase64Url(options.seed)
  if (seed?.length !== 32) throw new Error('E_LICENCE_CONFIG')
  const signer = await signerFromSeed(options.kid, seed)
  const id = options.id ?? newLicenceId()
  const key = await signLicence(signer, {
    id,
    licensee: options.licensee,
    issuedAt: instant(options.now),
  })
  return { id, key }
}

const USAGE =
  'Usage: LICENCE_SIGNING_KEY=… LICENCE_KID=… pnpm --filter @devot/licence issue [--id <licence ID>] <email>'

/** The command: its exit status; the key goes to `out`, problems (codes only) to `err`. */
export async function main(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: (text: string) => void,
  err: (text: string) => void,
  now = new Date(),
): Promise<number> {
  const parsed = parsedArgs(args)
  const licensee = parsed?.licensee ?? ''
  const id = parsed?.id
  const seed = env['LICENCE_SIGNING_KEY'] ?? ''
  const kid = env['LICENCE_KID'] ?? ''
  if (licensee === '' || !licensee.includes('@') || (id !== undefined && !LICENCE_ID.test(id))) {
    err(`E_LICENCE_BAD_REQUEST\n${USAGE}\n`)
    return 2
  }
  if (seed === '' || kid === '') {
    err(`E_LICENCE_CONFIG\n${USAGE}\n`)
    return 2
  }
  try {
    const issued = await issue({ seed, kid, licensee, now, ...(id === undefined ? {} : { id }) })
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

function parsedArgs(args: readonly string[]): { licensee: string; id?: string } | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { id: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    })
    if (positionals.length !== 1) return undefined
    const licensee = positionals[0]!.trim()
    return values.id === undefined ? { licensee } : { licensee, id: values.id }
  } catch {
    return undefined
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
