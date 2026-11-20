import type { ImportProblem, ImportReport } from '../../../core/import'
import { stopsImport } from './contributions'

export async function importBatch<T>(files: T[], importFile: (file: T) => Promise<ImportReport>) {
  let made = 0
  const problems: ImportProblem[] = []
  let error: unknown
  for (const file of files) {
    try {
      const report = await importFile(file)
      made += report.notes
      for (const problem of report.problems) {
        if (report.noteIds[problem.path] && problem.code !== 'E_IMPORT_INCOMPLETE')
          problems.push(problem)
        else error = new Error(problem.code)
      }
      if (report.problems.some((problem) => problem.code === 'E_IMPORT_STOPPED')) {
        error = new Error('E_IMPORT_STOPPED')
        break
      }
    } catch (cause) {
      error = cause
      if (stopsImport(cause)) break
    }
  }
  return { made, problems, error }
}
