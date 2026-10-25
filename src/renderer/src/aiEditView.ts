// What the Edit with AI sheet shows: a proposal's diff as rows, and why there is none, by the code the core or Rust refused with.
import { MAX_AI_EDIT_CHARS, type ProposalPart } from '../../core/aiEdit'
import { currentLocale, format, t, type MessageKey } from './i18n'

const REASONS: Record<string, MessageKey> = {
  E_LICENCE_REQUIRED: 'aiEdit.reason.licence',
  E_AI_ACCESS_DENIED: 'aiEdit.reason.access',
  E_AI_KEY_MISSING: 'aiEdit.reason.noKey',
  E_AI_KEYCHAIN_UNAVAILABLE: 'aiEdit.reason.noKey',
  E_AI_MODEL_MISSING: 'aiEdit.reason.noModel',
  E_AI_AUTH_FAILED: 'aiEdit.reason.auth',
  E_AI_RATE_LIMITED: 'aiEdit.reason.rateLimited',
  E_AI_NETWORK_FAILED: 'aiEdit.reason.network',
  E_AI_TIMEOUT: 'aiEdit.reason.network',
  E_AI_PROVIDER_UNAVAILABLE: 'aiEdit.reason.network',
  E_AI_REPLY_CUT_OFF: 'aiEdit.reason.cutOff',
  E_AI_REPLY_EMPTY: 'aiEdit.reason.empty',
  E_AI_SELECTION_TOO_LARGE: 'aiEdit.reason.tooLarge',
  E_AI_PROPOSAL_STALE: 'aiEdit.reason.stale',
  E_AI_REFUSED: 'aiEdit.reason.refused',
}

/** Asking again cannot help until the user changes something elsewhere (a notebook switch, a key, the selection). */
const SETTLED: ReadonlySet<string> = new Set([
  'E_LICENCE_REQUIRED',
  'E_AI_ACCESS_DENIED',
  'E_AI_KEY_MISSING',
  'E_AI_KEYCHAIN_UNAVAILABLE',
  'E_AI_MODEL_MISSING',
  'E_AI_AUTH_FAILED',
  'E_AI_SELECTION_TOO_LARGE',
  'E_AI_PROPOSAL_STALE',
])

export function aiEditFailure(code: string): { message: string; retry: boolean } {
  const reason = format(t(REASONS[code] ?? 'aiEdit.reason.other'), {
    count: MAX_AI_EDIT_CHARS.toLocaleString(currentLocale()),
  })
  return { message: format(t('aiEdit.failed'), { reason, code }), retry: !SETTLED.has(code) }
}

const SUGGEST_REASONS: Record<string, MessageKey> = {
  ...REASONS,
  E_AI_CONTEXT_EMPTY: 'aiSuggest.reason.empty',
  E_AI_SUGGESTION_NONE: 'aiSuggest.reason.none',
}

export function aiSuggestFailure(code: string): string {
  const reason = t(SUGGEST_REASONS[code] ?? 'aiSuggest.reason.other')
  return format(t('aiSuggest.failed'), { reason, code })
}

/** Unchanged lines shown around a change; longer runs fold to a count. */
const CONTEXT = 2

export type ProposalRow =
  | { kind: 'same' | 'added' | 'removed'; text: string; part: number }
  | { kind: 'skipped'; count: number }
  | { kind: 'take'; part: number }

/** The diff as rows: every changed line, CONTEXT unchanged lines on each side of a change, and a check box per change when there are several. */
export function proposalRows(parts: readonly ProposalPart[]): ProposalRow[] {
  const changes = parts.filter((p) => p.kind === 'change').length
  const rows: ProposalRow[] = []
  parts.forEach((part, i) => {
    if (part.kind === 'change') {
      if (changes > 1) rows.push({ kind: 'take', part: i })
      for (const text of part.removed) rows.push({ kind: 'removed', text, part: i })
      for (const text of part.added) rows.push({ kind: 'added', text, part: i })
      return
    }
    const head = i === 0 ? 0 : CONTEXT
    const tail = i === parts.length - 1 ? 0 : CONTEXT
    const { lines } = part
    if (lines.length <= head + tail + 1) {
      for (const text of lines) rows.push({ kind: 'same', text, part: i })
      return
    }
    for (const text of lines.slice(0, head)) rows.push({ kind: 'same', text, part: i })
    rows.push({ kind: 'skipped', count: lines.length - head - tail })
    for (const text of lines.slice(lines.length - tail)) rows.push({ kind: 'same', text, part: i })
  })
  return rows
}
