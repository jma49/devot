export function afterPaint(run: () => void): () => void {
  const cancel = () => {
    cancelAnimationFrame(frame)
    clearTimeout(timer)
  }
  const finish = () => {
    cancel()
    run()
  }
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(finish)
  })
  const timer = setTimeout(finish, 1000)
  return cancel
}
