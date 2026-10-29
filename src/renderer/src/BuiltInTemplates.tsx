import { t } from './i18n'
import { starterTemplate, starterTemplates } from './starterTemplates'

export function BuiltInTemplates(props: {
  selected: string | undefined
  onSelect: (id: string) => void
}) {
  return (
    <div className="builtin" role="group" aria-label={t('templates.builtIn')}>
      <div className="builtin-title">{t('templates.builtIn')}</div>
      {starterTemplates().map((template) => (
        <button
          key={template.id}
          type="button"
          className="builtin-row"
          aria-pressed={template.id === props.selected}
          onClick={() => props.onSelect(template.id)}
        >
          {template.title}
        </button>
      ))}
    </div>
  )
}

export function BuiltInTemplate(props: {
  id: string
  /** Only the preview works: the trial is over without a licence. The buttons stay
   * focusable and say they are off, as Empty Trash does, rather than vanishing
   * from the keyboard. */
  readOnly?: boolean
  onUse: (id: string) => void
  onEditCopy: (id: string) => void
}) {
  const template = starterTemplate(props.id)
  if (!template) return null
  return (
    <section className="builtin-view" aria-label={template.title}>
      <h2 className="builtin-heading">{template.title}</h2>
      <p className="note-meta template-hint">{t('templates.builtInHint')}</p>
      <div className="builtin-actions">
        <button
          type="button"
          className="button button-default"
          aria-disabled={props.readOnly || undefined}
          onClick={() => {
            if (!props.readOnly) props.onUse(template.id)
          }}
        >
          {t('templates.create')}
        </button>
        <button
          type="button"
          className="button"
          aria-disabled={props.readOnly || undefined}
          onClick={() => {
            if (!props.readOnly) props.onEditCopy(template.id)
          }}
        >
          {t('templates.editCopy')}
        </button>
      </div>
      <pre className="builtin-body" aria-label={t('templates.preview')}>
        {template.body}
      </pre>
    </section>
  )
}
