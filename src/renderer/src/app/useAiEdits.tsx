import { useMemo, useState } from 'react'
import { createAiGenerator } from '../../../core/aiProvider'
import { createSuggester } from '../../../core/aiSuggest'
import { aiTransport } from '../ai'
import { AiEditSheet } from '../AiEditSheet'
import { AiSuggestNotice } from '../AiSuggestNotice'
import type { Core } from '../core-client'
import type { AiEditStart } from '../editor/aiMenu'
import { licenceEntitlements } from '../licence'
import { loadAiSettings } from '../settings/aiProviders'

/** AI edits of the open note and next edit suggestions, each request through the notebooks' access rule. */
export function useAiEdits({
  core,
  selected,
  inTrash,
  applyToOpenNote,
}: {
  core: Core | undefined
  selected: string | undefined
  inTrash: boolean
  applyToOpenNote: (noteId: string, update: Uint8Array) => void
}) {
  // Every AI request goes through the access rule, with the notebooks as the core has them.
  const aiGenerator = useMemo(
    () =>
      core &&
      createAiGenerator({
        storage: { listBooks: () => core.listBooks() },
        transport: aiTransport,
        entitlements: licenceEntitlements,
      }),
    [core],
  )
  // Next edit suggestions go through the same rule, and the AI settings are read afresh at each request.
  const suggester = useMemo(
    () =>
      core &&
      aiGenerator &&
      createSuggester({
        generator: aiGenerator,
        bookOf: async (id) => (await core.read(id)).bookId,
        listBooks: () => core.listBooks(),
        settings: loadAiSettings,
        entitlements: licenceEntitlements,
      }),
    [core, aiGenerator],
  )
  const [suggestNotice, setSuggestNotice] = useState<string>()
  const [aiEditing, setAiEditing] = useState<{ noteId: string; start: AiEditStart }>()
  const notice = suggestNotice ? (
    <AiSuggestNotice code={suggestNotice} onDismiss={() => setSuggestNotice(undefined)} />
  ) : null
  const sheet =
    core && aiGenerator && aiEditing && aiEditing.noteId === selected && !inTrash ? (
      <AiEditSheet
        core={core}
        generator={aiGenerator}
        noteId={aiEditing.noteId}
        start={aiEditing.start}
        onApply={(update) => applyToOpenNote(aiEditing.noteId, update)}
        onClose={() => setAiEditing(undefined)}
        locked={!licenceEntitlements.has('aiProviders')}
      />
    ) : null
  return { suggester, setSuggestNotice, setAiEditing, notice, sheet }
}
