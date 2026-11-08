import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// CI helper: splits the iPhone UI test (src-tauri/apple/DevotUITests) between the `iphone-ui` jobs
// of .github/workflows/ci.yml. Each listed shard runs its classes and `Class/testMethod`s; REST runs
// every test not listed, so a new class or method can never be left out. Each shard should run about
// 4 minutes of tests on CI: when REST or a shard grows past that, move tests into a lighter shard or
// add one here and in the workflow's matrix (tests/policy/iphone-ui-shards.test.ts checks both).
// `node scripts/ci/iphone-ui-shards.ts <shard>` prints that shard's xcodebuild test selection.

// Seconds on CI (iOS 27.2, 2026-11-08): settings-1 211, settings-2 206, editor 173, rest 138; with
// EditorBarsTests, DeepLinkTests and ActivityTests in it, rest ran past 9 minutes, so they have shards of their own.
export const SHARDS: Record<string, string[]> = {
  'settings-1': [
    'SettingsTests/testGlassTransparencyIsKeptAcrossALaunch',
    'SettingsTests/testTheAppearancePanePassesTheAccessibilityAudit',
    'SettingsTests/testAThemeCardRingsBothOfItsSwatches',
  ],
  'settings-2': [
    'SettingsTests/testUnderReduceTransparencyTheGlassSliderIsLockedAndSaysWhy',
    'SettingsTests/testOpensEveryNativePaneAndComesBackToTheRoot',
    'SettingsTests/testASwitchChangesAndChangesBack',
    'SettingsTests/testTheSettingsRootPassesTheAccessibilityAudit',
    'SettingsTests/testTheAppRowOpensTheTrialSheetWhileATrialRunsAndLicenseOtherwise',
  ],
  editor: ['EditorTests', 'TabsTests'],
  'editor-bars': ['EditorBarsTests'],
  links: ['DeepLinkTests', 'ActivityTests'],
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
