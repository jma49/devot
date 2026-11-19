import { lazy, Suspense, type ComponentProps } from 'react'
import type { LivePreview as Live, Preview as Body } from './PreviewBody'

export { previewLabels, previewNote, type PreviewNoteFields } from './labels'

const Surface = lazy(() => import('./PreviewBody').then((module) => ({ default: module.Preview })))

export function Preview(props: ComponentProps<typeof Body>) {
  return (
    <Suspense fallback={null}>
      <Surface {...props} />
    </Suspense>
  )
}

export function LivePreview(props: ComponentProps<typeof Live>) {
  return <Preview {...props} />
}
