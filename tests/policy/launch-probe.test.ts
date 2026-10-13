import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { en } from '../../src/renderer/src/i18n/en'

const root = join(import.meta.dirname, '../..')
const read = (file: string) => readFileSync(join(root, file), 'utf8')

// The launch budget is "launch to first editor paint", so the probe must wait
// for the editor, not for the empty shell. It finds the editor and the New
// Note button by the catalog's labels, which a rename would otherwise leave
// stale and make the probe wait forever.
it('the launch probe waits for the editor, found by the catalog labels', () => {
  const probe = read('scripts/perf/first-paint.swift')
  expect(probe).toContain(`let editorLabel = "${en['note.bodyLabel']}"`)
  expect(probe).toContain(`let newNoteLabel = "${en['noteList.newNote']}"`)
  // The editor ends the wait; the shell is only a second number.
  expect(probe).toMatch(/find\(\$0, editorLabel\)[^\n]*\n[^\n]*print\(/)
  expect(probe).toContain('E_PROBE_TIMEOUT')
})

// The button is disabled until the core is ready, and a press on a disabled
// button can still report success, so the probe presses only an enabled button
// and presses again until the editor shows.
it('the launch probe presses New Note only while it is enabled, and retries', () => {
  const probe = read('scripts/perf/first-paint.swift')
  expect(probe).toContain('kAXEnabledAttribute')
  expect(probe).not.toMatch(/pressed\s*=\s*AXUIElementPerformAction/)
  expect(probe).toContain('lastPress')
})

it('the launch script seeds a note once and reports both times', () => {
  const perf = read('scripts/perf/launch-cost.sh')
  expect(perf.match(/^launch --seed$/gm)).toHaveLength(1)
  expect(perf).toContain('read -r SHELL_MS MS PID')
  expect(perf).toContain('to the editor')
})
