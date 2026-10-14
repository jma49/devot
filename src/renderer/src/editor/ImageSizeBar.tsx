// The image size bar: while the caret is in an image's Markdown, a floating
// bar under its line (over it when there is no room) sets the image's size
// preset: Auto, Small, Half or Full, written into the alt text (see
// core/images.ts). The current preset is drawn with a ring.
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { IMAGE_SIZES, type ImageSize } from '../../../core/images'
import { t, type MessageKey } from '../i18n'
import type { IconName } from '../icons/symbols'
import { BAR_GAP, barContent, FloatButton, floatTheme, NOTCH_X, useFloatTip } from './floating'
import { imageAtCaret, imageSizeChange, type EditorImage } from './images'
import { barsMayShow } from './barRules'
import { toolbarState, toolbarStateExtension } from './toolbarState'

/** The preset the bar shows as current; none for a size that is no preset. */
export function currentPreset(image: EditorImage): ImageSize | null {
  return image.dimensions ? null : image.size
}

function ImageSizeBar({ view, image }: { view: EditorView; image: EditorImage }) {
  const tip = useFloatTip(view)
  const current = currentPreset(image)
  return (
    <>
      <div role="toolbar" aria-label={t('imageBar.label')} className="cm-float-buttons">
        <span className="cm-float-label" aria-hidden="true">
          {t('imageBar.label')}
        </span>
        {IMAGE_SIZES.map((size) => {
          const label = t(`imageBar.${size}` as MessageKey)
          return (
            <FloatButton
              key={size}
              label={label}
              icon={`image.size.${size}` as IconName}
              tip={{ title: label }}
              pressed={current === size}
              onShowTip={tip.show}
              onHideTip={tip.hide}
              onPress={() => {
                const change = imageSizeChange(view.state, image, size)
                if (change) view.dispatch(change)
              }}
            />
          )
        })}
      </div>
      {tip.bubble}
    </>
  )
}

function createBar(view: EditorView): TooltipView {
  const dom = document.createElement('div')
  dom.className = 'cm-float-bar cm-image-size-bar'
  const root = createRoot(barContent(dom))
  const render = (state: EditorState) => {
    const image = imageAtCaret(state)
    // Re-rendered for the image the caret is in now; the tooltip goes away without one.
    if (image) root.render(<ImageSizeBar view={view} image={image} />)
  }
  return {
    dom,
    mount: () => flushSync(() => render(view.state)),
    update: (update) => {
      if (update.docChanged || update.selectionSet) render(update.state)
    },
    offset: { x: -NOTCH_X, y: BAR_GAP },
    destroy: () => queueMicrotask(() => root.unmount()),
  }
}

const barTooltip = showTooltip.compute(
  [toolbarState, 'selection', 'doc'],
  (state): Tooltip | null => {
    if (!barsMayShow(state)) return null
    const image = imageAtCaret(state)
    return image ? { pos: image.from, above: false, create: createBar } : null
  },
)

const theme = EditorView.theme({
  '.cm-tooltip.cm-image-size-bar': { width: 'max-content' },
})

/** The image size bar, for the note editor. */
export const imageSizeBar: Extension = [toolbarStateExtension, barTooltip, floatTheme, theme]
