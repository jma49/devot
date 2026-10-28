// What the window shows of this device's agent_writes index (ADR 0007): the list's mark on notes
// with unseen writes, the sidebar's Agents section, and the open note's notice. The rows are
// derived from each note's records, local and never synced; `seen` is this device's.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WriterKind } from '../../core/authorship'
import { errorCode } from '../../core/errors'
import { MAX_AGENT_WRITES_LISTED, type AgentWriteSummary } from '../../core/storage'
import { writerKey, type WriterRef } from './authorshipLabels'
import type { Core } from './core-client'

export interface AgentSummary {
  /** writerKey: the same kind and name across sessions. */
  key: string
  kind: WriterKind
  name: string
  /** The newest write's time. */
  at: number
  unseen: number
  noteIds: ReadonlySet<string>
}

export interface AgentWritesView {
  /** Each note's rows, newest first. */
  byNote: ReadonlyMap<string, readonly AgentWriteSummary[]>
  /** For each note with an unseen write, the writer of the newest one, as the UI names it. */
  changedBy: ReadonlyMap<string, WriterRef>
  /** The MCP clients and the HTTP API, newest first; Edit with AI is the owner's own. */
  agents: readonly AgentSummary[]
  /** Notes with any agent write, seen or not: the ones Clear Authorship applies to. */
  authored: ReadonlySet<string>
}

/** How many agents the sidebar lists at most. */
export const MAX_AGENTS_LISTED = 8

/** `rows` as listAgentWrites gives them (newest first), and the notes with any row at all. */
export function agentWritesView(
  rows: readonly AgentWriteSummary[],
  authored: Iterable<string> = [],
): AgentWritesView {
  const byNote = new Map<string, AgentWriteSummary[]>()
  const changedBy = new Map<string, WriterRef>()
  const agents = new Map<string, AgentSummary & { noteIds: Set<string> }>()
  for (const row of rows) {
    const own = byNote.get(row.noteId)
    if (own) own.push(row)
    else byNote.set(row.noteId, [row])
    if (!row.seen && !changedBy.has(row.noteId))
      changedBy.set(row.noteId, { kind: row.kind, name: row.name })
    addAgent(agents, row)
  }
  return {
    byNote,
    changedBy,
    agents: [...agents.values()].slice(0, MAX_AGENTS_LISTED),
    authored: new Set(authored),
  }
}

/** The open note's unseen writes, newest first. */
export const unseenOf = (view: AgentWritesView, noteId: string | undefined) =>
  noteId === undefined ? [] : (view.byNote.get(noteId) ?? []).filter((row) => !row.seen)

/**
 * `view` kept to `noteIds` (a workspace's notes): each agent's notes and unseen count are its own
 * there, and an agent with none of its notes there drops out.
 */
export function inNotes(view: AgentWritesView, noteIds: ReadonlySet<string>): AgentWritesView {
  const byNote = new Map<string, readonly AgentWriteSummary[]>()
  const changedBy = new Map<string, WriterRef>()
  const agents = new Map<string, AgentSummary & { noteIds: Set<string> }>()
  for (const [id, rows] of view.byNote) {
    if (!noteIds.has(id)) continue
    byNote.set(id, rows)
    const changed = changedByOf(rows)
    if (changed) changedBy.set(id, changed)
    for (const row of rows) addAgent(agents, row)
  }
  return {
    byNote,
    changedBy,
    agents: [...agents.values()].slice(0, MAX_AGENTS_LISTED),
    authored: new Set([...view.authored].filter((id) => noteIds.has(id))),
  }
}

/** The writer of a note's newest unseen row, as the UI names it. */
function changedByOf(rows: readonly AgentWriteSummary[]): WriterRef | undefined {
  const row = rows.find((r) => !r.seen)
  return row ? { kind: row.kind, name: row.name } : undefined
}

function addAgent(
  agents: Map<string, AgentSummary & { noteIds: Set<string> }>,
  row: AgentWriteSummary,
): void {
  if (row.kind === 'aiEdit') return
  const key = writerKey(row)
  const agent = agents.get(key)
  if (agent) {
    agent.noteIds.add(row.noteId)
    if (!row.seen) agent.unseen += 1
    agent.at = Math.max(agent.at, row.at)
  } else {
    agents.set(key, {
      key,
      kind: row.kind,
      name: row.name,
      at: row.at,
      unseen: row.seen ? 0 : 1,
      noteIds: new Set([row.noteId]),
    })
  }
}

/**
 * Marks `shown`'s rows seen. A promise, so a quit can wait for it; `reload` false when the app is
 * leaving, since nothing reads the rows again.
 */
export function markSeen(
  core: Pick<Core, 'markWritesSeen'>,
  reload: () => void,
  shown: { noteId: string; ids: ReadonlySet<string> } | undefined,
  options?: { reload?: boolean },
): Promise<void> {
  if (!shown || shown.ids.size === 0) return Promise.resolve()
  return core.markWritesSeen(shown.noteId, [...shown.ids]).then(
    () => {
      if (options?.reload !== false) reload()
    },
    (e: unknown) => console.warn('W_AGENT_WRITES_SEEN_FAILED', shown.noteId, errorCode(e)),
  )
}

const EMPTY = agentWritesView([])

/** Whether two reads name the same notes, whatever their order. */
const sameNotes = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id))

export const sameSummaries = (
  a: readonly AgentWriteSummary[],
  b: readonly AgentWriteSummary[],
): boolean =>
  a.length === b.length &&
  a.every((row, i) => {
    const other = b[i]!
    return (
      row.noteId === other.noteId &&
      row.writeId === other.writeId &&
      row.kind === other.kind &&
      row.name === other.name &&
      row.at === other.at &&
      row.created === other.created &&
      row.seen === other.seen
    )
  })

/**
 * This device's rows, read again whenever `when` changes (the note list after a write) and after
 * `reload`. A read that loses a race to a later one, or finds the rows unchanged, is dropped.
 */
export function useAgentWrites(core: Core | undefined, when: unknown) {
  const [view, setView] = useState<AgentWritesView>(EMPTY)
  const asked = useRef(0)
  const shown = useRef<readonly AgentWriteSummary[]>([])
  const shownAuthored = useRef<readonly string[]>([])
  const reload = useCallback(() => {
    if (!core) return
    const ask = (asked.current += 1)
    Promise.all([core.agentWrites(MAX_AGENT_WRITES_LISTED), core.authoredNotes()]).then(
      ([rows, authored]) => {
        // Each save reads again; the same rows keep the same view, so typing renders neither the window nor the sidebar.
        if (ask !== asked.current) return
        if (sameSummaries(shown.current, rows) && sameNotes(shownAuthored.current, authored)) return
        shown.current = rows
        shownAuthored.current = authored
        setView(agentWritesView(rows, authored))
      },
      (e: unknown) => console.warn('W_AGENT_WRITES_LIST_FAILED', e),
    )
  }, [core])
  useEffect(reload, [reload, when])
  return useMemo(() => ({ view, reload }), [view, reload])
}
