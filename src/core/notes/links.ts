import { headline, taskProgress } from '../extract'
import { findBacklinks } from '../links'
import type { NoteLinkTarget } from '../preview/registry'
import { MAX_BODY_IDS } from '../storage'
import type { NoteContext } from './context'
import type { Kernel } from './kernel'
import type { NoteService } from './types'

// One `getSummaries` read.
const MAX_LINK_TARGETS = MAX_BODY_IDS

export function linkMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<NoteService, 'backlinks' | 'linkTargets'> {
  const { storage, live } = ctx
  const { bodies } = k.memory
  return {
    backlinks: (id) => findBacklinks(storage, id),

    async linkTargets(ids) {
      const want = new Set(ids.slice(0, MAX_LINK_TARGETS))
      if (want.size === 0) return {}
      const [targets, tags] = await Promise.all([
        storage.getSummaries([...want]),
        storage.listTags(),
      ])
      const tagById = new Map(tags.filter((t) => t.deletedAt === null).map((t) => [t.id, t]))
      // Batched, and from memory where it is held: only the Markdown is needed, not each full record.
      const bodiesById = new Map(
        (await bodies(targets.map((summary) => summary.id))).map((body) => [body.id, body.bodyMd]),
      )
      const found: Record<string, NoteLinkTarget> = {}
      await Promise.all(
        targets.map((summary) => {
          const note = live.get(summary.id)
          const bodyMd = bodiesById.get(summary.id) ?? ''
          const title = note ? note.record.title : summary.title
          found[summary.id] = {
            title: title || headline(bodyMd),
            status: note ? note.record.status : summary.status,
            tasks: taskProgress(bodyMd),
            tags: summary.tagIds
              .flatMap((tagId) => {
                const tag = tagById.get(tagId)
                return tag ? [{ name: tag.name, color: tag.color }] : []
              })
              .sort((a, b) => a.name.localeCompare(b.name)),
          }
        }),
      )
      return found
    },
  }
}
