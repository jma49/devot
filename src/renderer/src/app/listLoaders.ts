import { useMemo } from 'react'
import type { Core } from '../core-client'
import { useEditorSetting } from '../editorSettings'
import { cardLabels } from '../galleryPreviews'

/** What list rows and cards load for the rows on screen: first lines, details, task counts, previews and activity strips. */
export function useListLoaders(core: Core | undefined) {
  const loadHeadlines = useMemo(
    () => (core ? (ids: string[]) => core.headlines(ids) : undefined),
    [core],
  )
  const loadDetails = useMemo(
    () => (core ? (ids: string[]) => core.rowDetails(ids) : undefined),
    [core],
  )
  const loadTaskCounts = useMemo(
    () => (core ? (ids: string[]) => core.taskCounts(ids) : undefined),
    [core],
  )
  const loadCardPreviews = useMemo(
    () => (core ? (ids: string[]) => core.cardPreviews(ids, cardLabels()) : undefined),
    [core],
  )
  const activityStrip = useEditorSetting('activityStrip')
  const loadStrips = useMemo(
    () =>
      core && activityStrip ? (ids: string[]) => core.noteActivity(ids, Date.now()) : undefined,
    [core, activityStrip],
  )
  return { loadHeadlines, loadDetails, loadTaskCounts, loadCardPreviews, loadStrips }
}

export type ListLoaders = ReturnType<typeof useListLoaders>
