export type CompletePreview = () => void | Promise<boolean>

export function whenComplete(complete: CompletePreview | undefined, run: () => void): void {
  const pending = complete?.()
  if (pending) {
    void pending.then((ready) => {
      if (ready) run()
    })
  } else run()
}
