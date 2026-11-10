import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// CI helper: splits the iPhone UI test (src-tauri/apple/DevotUITests) between the `iphone-ui` jobs
// of .github/workflows/ci.yml. A pull request runs SMOKE alone, about a minute of tests, so its
// checks end within ten minutes; the merge queue, main and manual runs run every shard.
// Each listed shard runs its classes and `Class/testMethod`s; REST runs every test not listed, so a
// new class or method can never be left out. A shard should run under 8 minutes of tests on CI:
// when one grows past that, move tests or add a shard here (tests/policy/iphone-ui-shards.test.ts
// checks the lists against the tests).
// `node scripts/ci/iphone-ui-shards.ts <shard>` prints that shard's xcodebuild test selection;
// `--matrix pull_request|full` prints the shards such a run tests, as the JSON of the job matrix.

// Seconds on CI (iOS 27.2, 2026-11-09): TabsTests 40 and the note link 26; SettingsTests 417;
// EditorTests 165 and EditorBarsTests 146; the rest about 360.
export const SMOKE = 'smoke'
export const SHARDS: Record<string, string[]> = {
  [SMOKE]: ['TabsTests', 'DeepLinkTests/testANoteLinkOpensTheNoteOverTheNotesList'],
  settings: ['SettingsTests'],
  editor: ['EditorTests', 'EditorBarsTests'],
}
export const REST = 'rest'

export function selection(shard: string): string[] {
  if (shard === REST) {
    return Object.values(SHARDS)
      .flat()
      .map((test) => `-skip-testing:DevotUITests/${test}`)
  }
  const tests = SHARDS[shard]
  if (!tests) throw new Error(`E_UI_SHARD_UNKNOWN shard=${shard}`)
  return tests.map((test) => `-only-testing:DevotUITests/${test}`)
}

export function matrix(run: string): string[] {
  if (run === 'pull_request') return [SMOKE]
  if (run === 'full') return [...Object.keys(SHARDS), REST]
  throw new Error(`E_UI_SHARD_RUN run=${run}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [first, second] = process.argv.slice(2)
  console.log(
    first === '--matrix' ? JSON.stringify(matrix(second ?? '')) : selection(first ?? '').join(' '),
  )
}
