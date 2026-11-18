import { lazy, Suspense, type ComponentProps } from 'react'
import type { RevisionHistory } from './RevisionHistory'

const History = lazy(() =>
  import('./RevisionHistory').then((module) => ({ default: module.RevisionHistory })),
)

export function LazyHistory(props: ComponentProps<typeof RevisionHistory>) {
  return (
    <Suspense fallback={null}>
      <History {...props} />
    </Suspense>
  )
}
