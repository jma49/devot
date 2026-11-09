import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// CI helper: splits the iPhone UI test (src-tauri/apple/DevotUITests) between the jobs of
// .github/workflows/ci.yml. SMOKE runs in `iphone-build` on every run that tests the app; the other
// shards and REST run in the `iphone-ui` matrix only for the merge queue, main and manual runs.
// Each listed shard runs its classes and `Class/testMethod`s; REST runs every test not listed, so a
// new class or method can never be left out. A matrix shard should run about 8 minutes of tests on
// CI, the smoke shard about 4: when one grows past that, move tests or add a shard here and in the
// workflow's matrix (tests/policy/iphone-ui-shards.test.ts checks both).
// `node scripts/ci/iphone-ui-shards.ts <shard>` prints that shard's xcodebuild test selection.

// Seconds on CI (iOS 27.2, 2026-11-09): SettingsTests 417; TabsTests, DeepLinkTests and ActivityTests
// about 190 together; the rest about 450.
export const SMOKE = 'smoke'
export const SHARDS: Record<string, string[]> = {
  [SMOKE]: ['TabsTests', 'DeepLinkTests', 'ActivityTests'],
  settings: ['SettingsTests'],
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(selection(process.argv[2] ?? '').join(' '))
}
