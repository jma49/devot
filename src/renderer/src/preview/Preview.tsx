import { lazy, Suspense, type ComponentProps } from 'react'
import type { LivePreview as Live, Preview as Body } from './PreviewBody'
import { PreviewFrame } from './PreviewFrame'

export { previewLabels, previewNote, type PreviewNoteFields } from './labels'

const Surface = lazy(() => import('./PreviewBody').then((module) => ({ default: module.Preview })))

function PreviewSurface(props: ComponentProps<typeof Body>) {
  return (
    <PreviewFrame>
      <Suspense fallback={null}>
        <Surface {...props} />
      </Suspense>
    </PreviewFrame>
  )
}

export { PreviewSurface as Preview }

export function LivePreview(props: ComponentProps<typeof Live>) {
  return <PreviewSurface {...props} />
}
