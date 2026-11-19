import { importMarkdown, imageLinks, type ImportOptions, type PreparedImport } from '../import'
import { checkUpload, detectImage, fileUri, MAX_FILE_BYTES } from '../files'
import { htmlToMarkdown } from '../htmlImport'
import { replaceRanges } from '../text'
import { errorCode } from '../errors'
import { checkResult, type Converted } from './protocol'

type PluginImportOptions = Omit<ImportOptions, 'scan' | 'source' | 'prepare'> & {
  name: string
  converted: Converted | Converted[]
}

function prepare(note: Converted, options: PluginImportOptions): PreparedImport {
  const embedded: PreparedImport['embedded'] = []
  const diagnostics = (note.diagnostics ?? []).map((code) => ({ code }))
  const uris = new Map<number, string>()
  for (const [index, attachment] of (note.attachments ?? []).entries()) {
    try {
      if (attachment.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4)
        throw new Error('E_FILE_SIZE_INVALID')
      const data = Uint8Array.from(atob(attachment.data), (c) => c.charCodeAt(0))
      const mime = detectImage(data)
      if (!mime || !attachment.mime.startsWith('image/'))
        throw new Error('E_IMPORT_ATTACHMENT_UNSUPPORTED')
      const id = options.newId()
      checkUpload({ id, noteId: id, name: attachment.name }, data)
      if (!options.files) throw new Error('E_IMPORT_ATTACHMENT_STORAGE')
      embedded.push({ id, mime, data, name: attachment.name })
      uris.set(index, fileUri(id))
    } catch (error) {
      diagnostics.push({ code: errorCode(error, 'E_IMPORT_ATTACHMENT_INVALID') })
    }
  }
  let text = note.markdown ?? ''
  let marker = 'https://devot.invalid/import/'
  if (note.html !== undefined) {
    while (note.html.includes(marker)) marker += 'x/'
    const html = note.html.replace(/attachment:(\d+)/g, (_, index: string) => `${marker}${index}`)
    const converted = htmlToMarkdown(html, options.newId)
    text = converted.markdown
    embedded.push(...converted.images)
    diagnostics.push(...converted.dropped.map(() => ({ code: 'E_IMPORT_HTML_CONTENT_DROPPED' })))
  }
  const links = imageLinks(text)
  text = replaceRanges(
    text,
    links.flatMap((link) => {
      const index =
        note.html === undefined
          ? /^attachment:(\d+)$/.exec(link.url)?.[1]
          : link.url.startsWith(marker)
            ? link.url.slice(marker.length)
            : undefined
      if (index === undefined || !/^\d+$/.test(index)) return []
      if (Number(index) >= (note.attachments?.length ?? 0))
        diagnostics.push({ code: 'E_IMPORT_ATTACHMENT_MISSING' })
      return [{ start: link.start, end: link.end, text: uris.get(Number(index)) ?? '' }]
    }),
  )
  const now = Date.now()
  const createdAt = note.createdAt ?? now
  const updatedAt = Math.max(createdAt, note.updatedAt ?? now)
  return {
    title: note.title,
    meta: { title: null, notebook: null, status: null, tags: note.tags ?? [] },
    aliases: [],
    text,
    embedded,
    diagnostics,
    dropped: [],
    images: { links: [], unlocated: [], wiki: [] },
    ...(note.createdAt !== undefined || note.updatedAt !== undefined
      ? { dates: { createdAt, updatedAt } }
      : {}),
  }
}

export async function importConverted(options: PluginImportOptions) {
  const checked = checkResult('import.convert', options.converted, 3)
  const many = Array.isArray(checked)
  const notes = many ? checked : [checked]
  const name = (options.name.split('/').pop() ?? options.name).replace(/\.[^.]+$/, '') || 'Import'
  const paths = notes.map((_, index) => (many ? `${name}/${index + 1}.md` : `${index + 1}.md`))
  return importMarkdown({
    ...options,
    wikiLinks: false,
    layout: {
      app: null,
      noteFolder: (path) => (many ? path.split('/').slice(0, -1).join('/') : ''),
      folderName: () => name,
      fileTitle: () => '',
    },
    scan: {
      id: 0,
      name: options.name,
      kind: many ? 'folders' : 'files',
      files: paths.map((path) => ({ path, bytes: 0 })),
      images: [],
      skipped: [],
    },
    source: {
      read: async () => '',
      attach: async () => {
        throw new Error('E_IMPORT_ATTACHMENT_MISSING')
      },
    },
    prepare: {
      file: async (_, path) => prepare(notes[paths.indexOf(path)]!, options),
      links: async () => ({ links: [], unlocated: [], wiki: [] }),
    },
  })
}
