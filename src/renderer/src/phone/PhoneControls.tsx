import { useId, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { haptic } from './haptics'
import { figureParts } from './figures'

/** A pane's card, with an optional group title and at most a one-line footnote. */
export function PhoneGroup(props: { title?: string; footnote?: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className="settings-block" aria-labelledby={props.title ? id : undefined}>
      {props.title ? (
        <h3 id={id} className="settings-block-title">
          {props.title}
        </h3>
      ) : null}
      <div className="settings-card">{props.children}</div>
      {props.footnote ? <p className="phone-footnote">{props.footnote}</p> : null}
    </section>
  )
}

function ControlHead(props: { id: string; label: string; description?: string | undefined }) {
  return (
    <div className="phone-control-head">
      <span id={props.id} className="setting-label">
        {props.label}
      </span>
      {props.description ? <span className="setting-description">{props.description}</span> : null}
    </div>
  )
}

export function PhoneSegmented<T extends string>(props: {
  label: string
  /** The choices (a period's days) or the group title say what it sets: the label is for assistive tech only. */
  labelHidden?: boolean | undefined
  description?: string | undefined
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  const id = useId()
  const index = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.value),
  )
  const pick = (value: T) => {
    if (value === props.value) return
    haptic('selection')
    props.onChange(value)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const count = props.options.length
    const next = props.options[(index + step + count) % count]!
    pick(next.value)
    const group = event.currentTarget
    requestAnimationFrame(() =>
      group.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus(),
    )
  }
  return (
    <div className="phone-control">
      {props.labelHidden ? null : (
        <ControlHead id={id} label={props.label} description={props.description} />
      )}
      <div
        role="radiogroup"
        {...(props.labelHidden ? { 'aria-label': props.label } : { 'aria-labelledby': id })}
        className="phone-segmented"
        style={{ '--segments': props.options.length, '--segment': index } as CSSProperties}
        onKeyDown={onKeyDown}
      >
        <span aria-hidden="true" className="phone-segmented-pill" />
        {props.options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === props.value}
            tabIndex={option.value === props.value ? 0 : -1}
            className="phone-segment"
            onClick={() => pick(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function PhoneSlider(props: {
  label: string
  /** The group title above the card already shows the label: it is for assistive tech only. */
  labelHidden?: boolean | undefined
  min: number
  max: number
  step: number
  value: number
  minLabel: string
  maxLabel: string
  valueText?: string
  /** The ends are one glyph, small and large, not words. */
  glyphEnds?: boolean
  onChange: (value: number) => void
  onRelease?: () => void
}) {
  const id = useId()
  const percent = ((props.value - props.min) / (props.max - props.min)) * 100
  return (
    <div className="phone-control">
      {props.labelHidden ? null : <ControlHead id={id} label={props.label} />}
      <div className="phone-slider-row" data-glyph-ends={props.glyphEnds || undefined}>
        <span className="phone-slider-end">{props.minLabel}</span>
        <input
          type="range"
          className="phone-slider"
          {...(props.labelHidden ? { 'aria-label': props.label } : { 'aria-labelledby': id })}
          aria-valuetext={props.valueText}
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          style={{ '--fill': `${percent}%` } as CSSProperties}
          onChange={(event) => props.onChange(Number(event.currentTarget.value))}
          onPointerUp={props.onRelease}
          onKeyUp={props.onRelease}
          onBlur={props.onRelease}
        />
        <span className="phone-slider-end">{props.maxLabel}</span>
      </div>
    </div>
  )
}

/** A message whose filled values take the figures style, its words staying in the body font. */
export function WithFigures(props: { template: string; values: Record<string, string> }) {
  return figureParts(props.template, props.values).map((part, index) =>
    part.figure ? (
      <span key={index} className="phone-figures">
        {part.text}
      </span>
    ) : (
      part.text
    ),
  )
}
