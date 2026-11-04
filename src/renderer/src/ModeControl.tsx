import { useRef } from 'react'
import { titleWithKey } from './commands/titles'
import { t, type MessageKey } from './i18n'
import { ToolIcon } from './icons/Icon'
import type { IconName } from './icons/symbols'
import { useSegmentSlide } from './segmentSlide'
import type { Mode } from './viewModes'

export { editorOnly, type Mode } from './viewModes'

const SEGMENT_MODES: { mode: Mode; icon: IconName; label: MessageKey }[] = [
  { mode: 'edit', icon: 'mode.edit', label: 'mode.edit' },
  { mode: 'split', icon: 'mode.split', label: 'mode.split' },
  { mode: 'preview', icon: 'mode.preview', label: 'mode.preview' },
]

export function ModeControl({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const group = useRef<HTMLDivElement>(null)
  useSegmentSlide(
    group,
    SEGMENT_MODES.findIndex((m) => m.mode === mode),
  )
  return (
    <>
      <button
        type="button"
        className="tool write-mode"
        aria-label={t('mode.write')}
        title={titleWithKey('mode.write', 'view.write')}
        aria-pressed={mode === 'write'}
        onClick={() => onChange('write')}
      >
        <ToolIcon name="mode.write" />
      </button>
      <div ref={group} className="segmented" role="group" aria-label={t('mode.label')}>
        {SEGMENT_MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            className="segment"
            aria-label={t(m.label)}
            title={t(m.label)}
            aria-pressed={mode === m.mode}
            onClick={() => onChange(m.mode)}
          >
            <ToolIcon name={m.icon} size="md" />
          </button>
        ))}
      </div>
    </>
  )
}
