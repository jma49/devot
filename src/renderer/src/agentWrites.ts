// What the window shows of this device's agent_writes index (ADR 0007): the list's mark on notes
// with unseen writes, the sidebar's Agents section, and the open note's notice. The rows are
// derived from each note's records, local and never synced; `seen` is this device's.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WriterKind } from '../../core/authorship'
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
}

/** How many agents the sidebar lists at most. */
export const MAX_AGENTS_LISTED = 8

/** `rows` as listAgentWrites gives them: newest first. */
export function agentWritesView(rows: readonly AgentWriteSummary[]): AgentWritesView {
  const byNote = new Map<string, AgentWriteSummary[]>()
  const changedBy = new Map<string, WriterRef>()
  const agents = new Map<string, AgentSummary & { noteIds: Set<string> }>()
  for (const row of rows) {
    const own = byNote.get(row.noteId)
    if (own) own.push(row)
    else byNote.set(row.noteId, [row])
    if (!row.seen && !changedBy.has(row.noteId))
      changedBy.set(row.noteId, { kind: row.kind, name: row.name })
    if (row.kind === 'aiEdit') continue
    const key = writerKey(row)
    const agent = agents.get(key)
    if (agent) {
      agent.noteIds.add(row.noteId)
      if (!row.seen) agent.unseen += 1
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
  return { byNote, changedBy, agents: [...agents.values()].slice(0, MAX_AGENTS_LISTED) }
}

/** The open note's unseen writes, newest first. */
export const unseenOf = (view: AgentWritesView, noteId: string | undefined) =>
  noteId === undefined ? [] : (view.byNote.get(noteId) ?? []).filter((row) => !row.seen)

const EMPTY = agentWritesView([])

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
  const reload = useCallback(() => {
    if (!core) return
    const ask = (asked.current += 1)
    core.agentWrites(MAX_AGENT_WRITES_LISTED).then(
      (rows) => {
        // Each save reads again; the same rows keep the same view, so typing renders neither the window nor the sidebar.
        if (ask !== asked.current || sameSummaries(shown.current, rows)) return
        shown.current = rows
        setView(agentWritesView(rows))
      },
      (e: unknown) => console.warn('W_AGENT_WRITES_LIST_FAILED', e),
    )
  }, [core])
  useEffect(reload, [reload, when])
  return useMemo(() => ({ view, reload }), [view, reload])
}
