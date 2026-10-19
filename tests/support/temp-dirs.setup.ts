import { afterAll } from 'vitest'
import { removeTempDirs } from './temp-dirs'

// Vitest setup. Its hooks run after the test file's own (after hooks run in reverse), so storage closes before its folder goes.
afterAll(removeTempDirs)
