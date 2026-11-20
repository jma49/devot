// What Settings > AI shows about providers and models, worked out from Rust's settings and model
// lists: each provider's state, the rows of the model picker, and why suggestions would not run.
import {
  isCliProvider,
  type AiCatalog,
  type AiCatalogModel,
  type AiProviderId,
  type AiSettingsChange,
  type AiSettingsView,
} from '../../../core/aiProvider'
import { providerReady } from '../../../core/aiSuggest'

/** The order of the picker's rail, the providers card and the first-run card. */
const ORDER: readonly AiProviderId[] = ['codexCli', 'claudeCli', 'anthropic', 'openai']

export type ProviderState =
  | 'ready'
  | 'needsKey'
  | 'keyUnknown'
  | 'keyUnavailable'
  | 'signedOut'
  | 'notInstalled'

export type StateDot = 'ok' | 'warn' | 'off'

export const STATE_DOTS: Record<ProviderState, StateDot> = {
  ready: 'ok',
  needsKey: 'off',
  keyUnknown: 'warn',
  keyUnavailable: 'off',
  signedOut: 'warn',
  notInstalled: 'off',
}

/** The providers this build can use: the local tools only where Rust reports them. */
export function aiProviders(view: AiSettingsView): AiProviderId[] {
  return ORDER.filter((id) => !isCliProvider(id) || view.cli !== undefined)
}

export function providerState(view: AiSettingsView, id: AiProviderId): ProviderState {
  if (isCliProvider(id)) {
    const state = view.cli?.[id].state ?? 'notInstalled'
    return state === 'ready' ? 'ready' : state
  }
  switch (view[id].key) {
    case 'set':
      return 'ready'
    case 'unknown':
      return 'keyUnknown'
    case 'unavailable':
      return 'keyUnavailable'
    default:
      return 'needsKey'
  }
}

/** Nothing can answer the Model setting until a key is added or a tool is ready, so the pane leads with how to set one up. A missing model is chosen in the picker instead. */
export function isFirstRun(view: AiSettingsView): boolean {
  const ready = providerReady(view, 'main')
  return ready !== 'ready' && ready !== 'E_AI_MODEL_MISSING'
}

/** A model choice: an empty `model` is the provider's default, a null `reasoning` the model's. */
export interface ModelChoice {
  provider: AiProviderId
  model: string
  reasoning: string | null
}

export type PickerTarget = 'main' | 'suggest'

const providerModel = (view: AiSettingsView, id: AiProviderId) =>
  isCliProvider(id)
    ? { model: view.cli?.[id].model ?? '', reasoning: view.cli?.[id].reasoning ?? null }
    : { model: view[id].model, reasoning: view[id].reasoning }

export function mainChoice(view: AiSettingsView): ModelChoice {
  return { provider: view.active, ...providerModel(view, view.active) }
}

/** The model suggestions use: the suggestion model, or the Model setting when none is named. */
export function suggestChoice(view: AiSettingsView): ModelChoice {
  const named = view.suggestModel
  if (!named) return mainChoice(view)
  const main = providerModel(view, named.provider)
  return {
    provider: named.provider,
    model: named.model === '' ? main.model : named.model,
    reasoning: named.reasoning,
  }
}

/** A provider's model list as the pane holds it; `request` ties a list being fetched to the fetch that asked. */
export type CatalogLoad = { state: 'idle' } | { state: 'loading'; request: number } | AiCatalog

export type Catalogs = Partial<Record<AiProviderId, CatalogLoad>>

const readyModels = (load: CatalogLoad | undefined): readonly AiCatalogModel[] =>
  load?.state === 'ready' ? load.models : []

/** The model a choice names, the default one for an empty ID, where the list says which it is. */
export function chosenModel(catalogs: Catalogs, choice: ModelChoice): AiCatalogModel | undefined {
  const load = catalogs[choice.provider]
  if (load?.state !== 'ready') return undefined
  const id = choice.model === '' ? load.defaultModel : choice.model
  return id === null ? undefined : load.models.find((m) => m.id === id)
}

/** Cloud models as last seen in their provider's list, by the choice that named them (`provider/model`). */
export type KnownModels = Readonly<Record<string, AiCatalogModel>>

const knownKey = (choice: ModelChoice) => `${choice.provider}/${choice.model}`

/** The chosen model from its list, else as last seen there: a cloud list is fetched only when asked for. */
export function shownModel(
  catalogs: Catalogs,
  known: KnownModels,
  choice: ModelChoice,
): AiCatalogModel | undefined {
  return chosenModel(catalogs, choice) ?? known[knownKey(choice)]
}

/** The known models of the cloud choices held now, each read again from its list when that list is loaded. */
export function rememberChoices(
  known: KnownModels,
  catalogs: Catalogs,
  choices: readonly ModelChoice[],
): KnownModels {
  const next: Record<string, AiCatalogModel> = {}
  for (const choice of choices) {
    if (isCliProvider(choice.provider)) continue
    const model = shownModel(catalogs, known, choice)
    if (model) next[knownKey(choice)] = model
  }
  return next
}

/** The name a choice shows: the model's own, the ID when the list does not hold it, or null for the provider's unnamed default. */
export function choiceName(
  catalogs: Catalogs,
  choice: ModelChoice,
  known: KnownModels = {},
): string | null {
  const model = shownModel(catalogs, known, choice)
  if (model) return model.name
  return choice.model === '' ? null : choice.model
}

/** The levels the reasoning column offers for a choice, lowest first, and the one used when none is picked. */
export function reasoningLevels(
  catalogs: Catalogs,
  choice: ModelChoice,
): { levels: readonly string[]; fallback: string | null } {
  const model = chosenModel(catalogs, choice)
  return model
    ? { levels: model.reasoning, fallback: model.defaultReasoning }
    : { levels: [], fallback: null }
}

/** A stored level is kept only when the new model is listed and takes it: an unlisted model hides the Reasoning column, so a kept level could not be seen or changed. */
function keptReasoning(
  catalogs: Catalogs,
  choice: ModelChoice,
  level: string | null,
): string | null {
  if (level === null) return null
  const model = chosenModel(catalogs, choice)
  return model?.reasoning.includes(level) ? level : null
}

function withProvider(
  view: AiSettingsView,
  id: AiProviderId,
  model: string,
  reasoning: string | null,
): AiSettingsView {
  if (isCliProvider(id)) {
    if (!view.cli) return view
    return { ...view, cli: { ...view.cli, [id]: { ...view.cli[id], model, reasoning } } }
  }
  return { ...view, [id]: { ...view[id], model, reasoning } }
}

/** The settings once `model` of `provider` is chosen in a picker; a suggestion model of null follows the Model setting. */
export function choose(
  view: AiSettingsView,
  target: PickerTarget,
  catalogs: Catalogs,
  picked: { provider: AiProviderId; model: string } | null,
): AiSettingsView {
  if (target === 'suggest') {
    if (!picked) return { ...view, suggestModel: null }
    const before = view.suggestModel
    const level = before?.provider === picked.provider ? before.reasoning : null
    const choice = { ...picked, reasoning: null }
    return {
      ...view,
      suggestModel: { ...picked, reasoning: keptReasoning(catalogs, choice, level) },
    }
  }
  if (!picked) return view
  const level = providerModel(view, picked.provider).reasoning
  const choice = { ...picked, reasoning: null }
  return {
    ...withProvider(view, picked.provider, picked.model, keptReasoning(catalogs, choice, level)),
    active: picked.provider,
  }
}

/** The settings with a reasoning level picked; null is the model's default. */
export function chooseReasoning(
  view: AiSettingsView,
  target: PickerTarget,
  level: string | null,
): AiSettingsView {
  if (target === 'suggest') {
    // A level picked while following the Model setting names that model, so the row shows what was pinned.
    const named = view.suggestModel ?? {
      provider: view.active,
      model: providerModel(view, view.active).model,
      reasoning: null,
    }
    return { ...view, suggestModel: { ...named, reasoning: level } }
  }
  return withProvider(view, view.active, providerModel(view, view.active).model, level)
}

/** Every field Settings changes, as Rust takes them (`ai_settings_set`). */
export function settingsChange(view: AiSettingsView): AiSettingsChange {
  const http = (id: 'anthropic' | 'openai') => ({
    endpoint: view[id].endpoint,
    model: view[id].model,
    reasoning: view[id].reasoning,
  })
  return {
    active: view.active,
    suggestOnIdle: view.suggestOnIdle,
    anthropic: http('anthropic'),
    openai: http('openai'),
    ...(view.cli
      ? {
          claudeCli: { model: view.cli.claudeCli.model, reasoning: view.cli.claudeCli.reasoning },
          codexCli: { model: view.cli.codexCli.model, reasoning: view.cli.codexCli.reasoning },
        }
      : {}),
    suggestModel: view.suggestModel,
  }
}

export const RECENT_LIMIT = 3

export interface RecentModel {
  provider: AiProviderId
  model: string
}

export function addRecent(recent: readonly RecentModel[], picked: RecentModel): RecentModel[] {
  return [
    picked,
    ...recent.filter((r) => r.provider !== picked.provider || r.model !== picked.model),
  ].slice(0, RECENT_LIMIT)
}

/** A row of the picker that can be chosen; the others are its section titles and notes. */
export type PickerRow =
  | { kind: 'same' }
  | {
      kind: 'model'
      provider: AiProviderId
      model: string
      name: string | null
      tier: AiCatalogModel['tier']
      recent?: number
    }
  | { kind: 'other'; provider: AiProviderId }

/** What the picker lists under the rail's provider when it has no models to show. */
export type ProviderNote =
  | { kind: 'blocked'; state: Exclude<ProviderState, 'ready'> }
  | { kind: 'loading' }
  | { kind: 'failed'; code: string }

export interface PickerSection {
  title: { kind: 'recent' } | { kind: 'provider'; provider: AiProviderId; ready: boolean } | null
  rows: PickerRow[]
  note?: ProviderNote
}

export interface PickerInput {
  view: AiSettingsView
  target: PickerTarget
  catalogs: Catalogs
  recent: readonly RecentModel[]
  /** The provider chosen in the rail. */
  rail: AiProviderId
  query: string
}

function modelRow(provider: AiProviderId, m: AiCatalogModel, recent?: number): PickerRow {
  return {
    kind: 'model',
    provider,
    model: m.id,
    name: m.name,
    tier: m.tier,
    ...(recent === undefined ? {} : { recent }),
  }
}

/** The picker's rows: with a query, the matching models of every provider; without, Recent, then the rail provider's list. */
export function pickerSections(input: PickerInput): PickerSection[] {
  const { view, target, catalogs, recent, rail } = input
  const providers = aiProviders(view)
  const query = input.query.trim().toLocaleLowerCase()
  if (query !== '') {
    const sections: PickerSection[] = []
    for (const id of providers) {
      const rows = readyModels(catalogs[id])
        .filter(
          (m) =>
            m.name.toLocaleLowerCase().includes(query) || m.id.toLocaleLowerCase().includes(query),
        )
        .map((m) => modelRow(id, m))
      if (rows.length > 0) {
        sections.push({
          title: { kind: 'provider', provider: id, ready: providerState(view, id) === 'ready' },
          rows,
        })
      }
    }
    if (sections.length === 0) {
      sections.push({
        title: null,
        rows: [{ kind: 'other', provider: rail }],
      })
    }
    return sections
  }
  const sections: PickerSection[] = []
  if (target === 'suggest') sections.push({ title: null, rows: [{ kind: 'same' }] })
  const shownRecent = recent.filter((r) => providers.includes(r.provider)).slice(0, RECENT_LIMIT)
  if (shownRecent.length > 0) {
    sections.push({
      title: { kind: 'recent' },
      rows: shownRecent.map((r, i) => {
        const known = readyModels(catalogs[r.provider]).find((m) => m.id === r.model)
        return known
          ? modelRow(r.provider, known, i)
          : {
              kind: 'model',
              provider: r.provider,
              model: r.model,
              name: r.model === '' ? null : r.model,
              tier: null,
              recent: i,
            }
      }),
    })
  }
  const state = providerState(view, rail)
  const title = { kind: 'provider', provider: rail, ready: state === 'ready' } as const
  if (state !== 'ready') {
    sections.push({ title, rows: [], note: { kind: 'blocked', state } })
    return sections
  }
  const load = catalogs[rail]
  const rows: PickerRow[] = []
  // A local tool picks its own model when none is named.
  if (isCliProvider(rail)) {
    rows.push({ kind: 'model', provider: rail, model: '', name: null, tier: null })
  }
  if (load?.state === 'ready') rows.push(...load.models.map((m) => modelRow(rail, m)))
  // The model in use stays choosable when the list does not hold it (an ID typed earlier).
  const current = providerModel(view, rail).model
  if (current !== '' && !rows.some((r) => r.kind === 'model' && r.model === current)) {
    rows.push({ kind: 'model', provider: rail, model: current, name: current, tier: null })
  }
  rows.push({ kind: 'other', provider: rail })
  const note: ProviderNote | undefined =
    load === undefined || load.state === 'idle' || load.state === 'loading'
      ? { kind: 'loading' }
      : load.state === 'failed'
        ? { kind: 'failed', code: load.code }
        : undefined
  sections.push(note ? { title, rows, note } : { title, rows })
  return sections
}

/** The rows the keyboard moves through, in order. */
export const choosableRows = (sections: readonly PickerSection[]): PickerRow[] =>
  sections.flatMap((s) => s.rows)

/** Whether a row is what the picker's target holds now. */
export function isCurrentRow(view: AiSettingsView, target: PickerTarget, row: PickerRow): boolean {
  if (row.kind === 'same') return target === 'suggest' && view.suggestModel === null
  if (row.kind !== 'model') return false
  if (target === 'suggest' && view.suggestModel === null) return false
  const choice = target === 'main' ? mainChoice(view) : suggestChoice(view)
  return choice.provider === row.provider && choice.model === row.model
}

/** Why suggestions after a pause would not come, checked in the order a person would fix them. */
export type SuggestStatus =
  | { kind: 'off' }
  | { kind: 'licence' }
  | { kind: 'noNotebooks' }
  | {
      kind: 'provider'
      provider: AiProviderId
      code: Exclude<ReturnType<typeof providerReady>, 'ready'>
    }
  | { kind: 'ready'; choice: ModelChoice }

export function suggestStatus(
  view: AiSettingsView,
  context: { licensed: boolean; allowedNotebooks: number | undefined },
): SuggestStatus {
  if (!view.suggestOnIdle) return { kind: 'off' }
  if (!context.licensed) return { kind: 'licence' }
  if (context.allowedNotebooks === 0) return { kind: 'noNotebooks' }
  const ready = providerReady(view, 'suggest')
  const choice = suggestChoice(view)
  if (ready !== 'ready') return { kind: 'provider', provider: choice.provider, code: ready }
  return { kind: 'ready', choice }
}
