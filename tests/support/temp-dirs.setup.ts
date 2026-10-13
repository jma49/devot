import { afterAll } from 'vitest'
import { removeTempDirs } from './temp-dirs'

// Vitest setup file. Hooks registered here run after the test file's own
// (after hooks run in reverse order), so storage is closed before its
// folder goes.
afterAll(removeTempDirs)
