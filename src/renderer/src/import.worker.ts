// Converts and parses the files an import reads, off the core worker (importWorker.ts).
import { errorCode } from '../../core/errors'
import { createIdGenerator } from '../../core/ids'
import { imagesIn, prepareImportFile } from '../../core/import'
import type { ImportReply, ImportRequest } from './importWorker'

const newId = createIdGenerator()

const reply = (message: ImportReply, transfer: Transferable[] = []) =>
  self.postMessage(message, { transfer })

self.addEventListener('message', (event: MessageEvent<ImportRequest>) => {
  const request = event.data
  try {
    if (request.kind === 'links') {
      reply({ id: request.id, value: imagesIn(request.text) })
      return
    }
    const value = prepareImportFile(
      request.raw,
      request.path,
      request.withImages ? newId : undefined,
    )
    reply({ id: request.id, value }, [...new Set(value.embedded.map((image) => image.data.buffer))])
  } catch (error) {
    reply({ id: request.id, code: errorCode(error, 'E_IMPORT_FAILED') })
  }
})
