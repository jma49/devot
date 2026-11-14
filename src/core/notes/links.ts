import { frontMatterEnd, headline, taskProgress } from '../extract'
import { linkGraphView, MAX_GRAPH_LINKS } from '../graph'
import { findBacklinks, linkText, noteLinks, noteUri } from '../links'
import { findMention, mentionable, mentionExcerpt } from '../mentions'
import type { NoteLinkTarget } from '../preview/registry'
import { excludeTemplates, SEARCH_LIMIT } from '../search'
import { MAX_BODY_IDS } from '../storage'
import { TEMPLATES_BOOK_ID } from '../templatesBook'
import { BODY } from './body'
import type { NoteContext } from './context'
import type { Kernel } from './kernel'
import type { NoteSummary } from '../storage'
import type { NoteService } from './types'

// One `getSummaries` read.
const MAX_LINK_TARGETS = MAX_BODY_IDS

/** An embedded note shows this much of its body at most. */
export const MAX_EMBED_CHARS = 10_000

/** The body an embed shows: without front matter, cut at the last line break within MAX_EMBED_CHARS. */
export function embeddedBody(bodyMd: string): { markdown: string; clipped: boolean } {
  const body = bodyMd.slice(frontMatterEnd(bodyMd)).replace(/^\n+/, '')
  if (body.length <= MAX_EMBED_CHARS) return { markdown: body, clipped: false }
  const cut = body.lastIndexOf('\n', MAX_EMBED_CHARS)
  return { markdown: body.slice(0, cut > 0 ? cut : MAX_EMBED_CHARS), clipped: true }
}

/** Unlinked mentions listed for one note at most. */
export const MAX_MENTIONS = 50

export type NoteMention = NoteSummary & { excerpt: string }

export function linkMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<
  NoteService,
  'backlinks' | 'linkTargets' | 'summaries' | 'mentions' | 'linkMention' | 'linkGraph'
> {
  const { storage, live } = ctx
  const { bodies, summaries, using } = k.memory
  const { saveAll } = k.saving
  const { takeVersion, settled } = k.versions
  const { collected, replaceBody } = k.edits

  const titleOf = async (id: string): Promise<string> => {
    const note = live.get(id)
    if (note) return note.record.title
    return (await storage.getSummaries([id]))[0]?.title ?? ''
  }

  return {
    backlinks: (id) => findBacklinks(storage, id),

    async linkGraph(focus) {
      const [raw, focusTitle] = await Promise.all([
        storage.listLinkGraph(TEMPLATES_BOOK_ID, MAX_GRAPH_LINKS),
        focus === undefined ? undefined : titleOf(focus),
      ])
      return linkGraphView(raw, focusTitle === undefined ? {} : { focus, focusTitle })
    },

    async mentions(id) {
      const title = (await titleOf(id)).trim()
      if (!mentionable(title)) return []
      await saveAll()
      const query = excludeTemplates({
        text: [{ field: 'body', value: title, negate: false }],
        sets: [],
        pinned: null,
      })
      const hits = (await storage.searchNotes(query, SEARCH_LIMIT)).filter((hit) => hit.id !== id)
      const bodyOf = new Map((await bodies(hits.map((hit) => hit.id))).map((b) => [b.id, b.bodyMd]))
      const found: NoteMention[] = []
      for (const hit of hits) {
        const body = bodyOf.get(hit.id)
        if (body === undefined || noteLinks(body).includes(id)) continue
        const mention = findMention(body, title)
        if (!mention) continue
        const { excerpt: _searched, ...summary } = hit
        found.push({ ...summary, excerpt: mentionExcerpt(body, mention) })
        if (found.length === MAX_MENTIONS) break
      }
      return found
    },

    async linkMention(sourceId, targetId) {
      const title = (await titleOf(targetId)).trim()
      return using(sourceId, async (note) => {
        const body = note.doc.getText(BODY).toString()
        const mention = noteLinks(body).includes(targetId) ? null : findMention(body, title)
        if (!mention) throw new Error('E_MENTION_NOT_FOUND')
        const shown = body.slice(mention.from, mention.to)
        const link = `[${linkText(shown)}](${noteUri(targetId)})`
        takeVersion(note)
        const update = collected(note, () =>
          replaceBody(note, body.slice(0, mention.from) + link + body.slice(mention.to)),
        )
        takeVersion(note)
        await settled()
        return update
      })
    },

    summaries,

    async linkTargets(ids, embeds = []) {
      const want = new Set(ids.slice(0, MAX_LINK_TARGETS))
      const embedded = new Set(embeds.filter((id) => want.has(id)))
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
            ...(embedded.has(summary.id) ? { embed: embeddedBody(bodyMd) } : {}),
          }
        }),
      )
      return found
    },
  }
}
