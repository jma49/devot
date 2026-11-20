import type { AiSettingsView } from '../../../core/aiProvider'

/**
 * Settings > AI talks to Rust one call after another, so two saves never race. A change shows at
 * once, laid over what Rust last answered, and is built at send time from that answer, so a change
 * made while an earlier call ran is neither lost nor undone by the earlier answer.
 */
export interface AiSettingsQueue {
  /** What the pane shows: Rust's last answer with every change not yet answered laid over it. */
  shown(): AiSettingsView | undefined
  /** Takes Rust's settings as read when the pane opened. */
  loaded(view: AiSettingsView): void
  /** Saves `patch` of the settings as they stand when it is sent; settles once Rust answered or refused. */
  change(patch: (view: AiSettingsView) => AiSettingsView): Promise<void>
  /** Runs a call that answers with the settings (a key stored, the tools checked) in turn; rejects with its error. */
  run(call: () => Promise<AiSettingsView>): Promise<AiSettingsView>
}

export function createAiSettingsQueue(options: {
  save: (view: AiSettingsView) => Promise<AiSettingsView>
  /** Whether two views would send the same settings. */
  same: (a: AiSettingsView, b: AiSettingsView) => boolean
  onShown: (view: AiSettingsView) => void
  onRefused: (e: unknown) => void
}): AiSettingsQueue {
  let held: AiSettingsView | undefined
  const unanswered: Array<(view: AiSettingsView) => AiSettingsView> = []
  let queue: Promise<unknown> = Promise.resolve()

  const shown = () => (held ? unanswered.reduce((view, patch) => patch(view), held) : undefined)
  const show = () => {
    const view = shown()
    if (view) options.onShown(view)
  }
  const after = <T>(job: () => Promise<T>): Promise<T> => {
    const done = queue.then(job)
    queue = done.catch(() => undefined)
    return done
  }

  return {
    shown,
    loaded(view) {
      held = view
      show()
    },
    change(patch) {
      if (!held) return Promise.resolve()
      unanswered.push(patch)
      show()
      return after(async () => {
        const before = held
        try {
          if (!before) return
          const sent = patch(before)
          if (!options.same(sent, before)) held = await options.save(sent)
        } catch (e) {
          options.onRefused(e)
        } finally {
          unanswered.splice(unanswered.indexOf(patch), 1)
          show()
        }
      })
    },
    run(call) {
      return after(async () => {
        const answer = await call()
        held = answer
        show()
        return answer
      })
    },
  }
}
