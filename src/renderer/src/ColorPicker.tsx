import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import {
  hexToHsv,
  hsvToHex,
  hueGradient,
  readHexDraft,
  spectrumGradient,
  type Hsv,
} from './theme/hsv'
import { clamp } from './clamp'
import { format, t } from './i18n'
import { isImeKey } from './ime'
import { tagColorStyle } from './tagColorStyle'
import { dotCase } from './TagDot'

const START: Hsv = { h: 210, s: 0.7, v: 0.85 }
const percent = (value: number) => Math.round(value * 100)

function fractionsAt(e: PointerEvent<HTMLElement>) {
  const box = e.currentTarget.getBoundingClientRect()
  return {
    x: clamp((e.clientX - box.left) / box.width, 0, 1),
    y: clamp((e.clientY - box.top) / box.height, 0, 1),
  }
}

/** Follows the pointer from a press to its release, wherever it goes. */
function dragProps(onMove: (at: { x: number; y: number }) => void) {
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture?.(e.pointerId)
      e.currentTarget.focus()
      onMove(fractionsAt(e))
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) onMove(fractionsAt(e))
    },
  }
}

/**
 * A custom colour: saturation and brightness on a spectrum, a hue slider and a hex field, with the
 * tag's chip as it will look in light and in dark. Nothing leaves it until `onDone`: a hex that
 * is not one yet stays in its field.
 */
export function ColorPicker(props: {
  value: string | null
  tagName: string
  onDone: (hex: `#${string}`) => void
  onCancel: () => void
}) {
  const [hsv, setHsv] = useState<Hsv>(() => (props.value ? hexToHsv(props.value) : START))
  const [text, setText] = useState(() => props.value ?? hsvToHex(START))
  const draft = readHexDraft(text)
  const hex = typeof draft === 'object' ? draft.hex : null
  const shown = hex ?? hsvToHex(hsv)
  const hues = useMemo(() => hueGradient(), [])

  const moveTo = (next: Hsv) => {
    setHsv(next)
    setText(hsvToHex(next))
  }
  const done = () => {
    if (hex) props.onDone(hex as `#${string}`)
  }
  const onPanelKey = (e: KeyboardEvent) => {
    if (isImeKey(e.nativeEvent)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      props.onCancel()
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault()
      e.stopPropagation()
      done()
    }
  }
  const spectrumKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01
    const change: Partial<Record<string, Partial<Hsv>>> = {
      ArrowLeft: { s: clamp(hsv.s - step, 0, 1) },
      ArrowRight: { s: clamp(hsv.s + step, 0, 1) },
      ArrowDown: { v: clamp(hsv.v - step, 0, 1) },
      ArrowUp: { v: clamp(hsv.v + step, 0, 1) },
    }
    const move = change[e.key]
    if (!move) return
    e.preventDefault()
    moveTo({ ...hsv, ...move })
  }
  const hueKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1
    const next =
      e.key === 'ArrowLeft' || e.key === 'ArrowDown'
        ? hsv.h - step
        : e.key === 'ArrowRight' || e.key === 'ArrowUp'
          ? hsv.h + step
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? 359
              : undefined
    if (next === undefined) return
    e.preventDefault()
    moveTo({ ...hsv, h: clamp(next, 0, 359) })
  }
  const chip = (appearance: 'light' | 'dark') => (
    <div
      className="color-picker-preview"
      data-appearance-preview={appearance}
      role="img"
      aria-label={t(
        appearance === 'light' ? 'colorPicker.previewLight' : 'colorPicker.previewDark',
      )}
    >
      <span className="chip tag-chip tag-color-custom" style={tagColorStyle(shown as `#${string}`)}>
        <span
          className="tag-dot tag-color-custom"
          style={tagColorStyle(shown as `#${string}`)}
          data-lowercase={dotCase(props.tagName)}
          aria-hidden="true"
        />
        <span dir="auto">{props.tagName}</span>
      </span>
    </div>
  )

  return (
    <div className="color-picker" onKeyDown={onPanelKey}>
      <div
        className="color-picker-spectrum"
        role="slider"
        tabIndex={0}
        aria-label={t('colorPicker.spectrum')}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent(hsv.s)}
        aria-valuetext={format(t('colorPicker.spectrumValue'), {
          saturation: String(percent(hsv.s)),
          brightness: String(percent(hsv.v)),
        })}
        style={{ backgroundImage: spectrumGradient(hsv.h) }}
        onKeyDown={spectrumKey}
        {...dragProps(({ x, y }) => moveTo({ ...hsv, s: x, v: 1 - y }))}
      >
        <span
          className="color-picker-handle"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: shown }}
        />
      </div>
      <div
        className="color-picker-hue"
        role="slider"
        tabIndex={0}
        aria-label={t('colorPicker.hue')}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(hsv.h)}
        style={{ backgroundImage: hues }}
        onKeyDown={hueKey}
        {...dragProps(({ x }) => moveTo({ ...hsv, h: Math.min(359, x * 360) }))}
      >
        <span className="color-picker-handle" style={{ left: `${(hsv.h / 359) * 100}%` }} />
      </div>
      <label className="color-picker-hex">
        <span className="color-picker-hex-label">{t('colorPicker.hex')}</span>
        <input
          className="pick-filter"
          type="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={draft === 'invalid'}
          aria-describedby={draft === 'invalid' ? 'color-picker-hex-error' : undefined}
          value={text}
          onChange={(e) => {
            const next = e.target.value
            setText(next)
            const read = readHexDraft(next)
            if (typeof read === 'object') setHsv(hexToHsv(read.hex))
          }}
        />
      </label>
      {draft === 'invalid' ? (
        <p id="color-picker-hex-error" className="color-picker-error" role="alert">
          {t('colorPicker.hexInvalid')}
        </p>
      ) : null}
      <div className="color-picker-previews">
        {chip('light')}
        {chip('dark')}
      </div>
      <div className="confirm-actions">
        <button type="button" className="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
        <button type="button" className="button button-default" disabled={!hex} onClick={done}>
          {t('colorPicker.done')}
        </button>
      </div>
    </div>
  )
}
