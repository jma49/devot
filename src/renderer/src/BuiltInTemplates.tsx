import { STARTER_TEMPLATES, starterTemplate } from '../../core'
import { t } from './i18n'

export function BuiltInTemplates(props: {
  selected: string | undefined
  onSelect: (id: string) => void
}) {
  return (
    <div className="builtin" role="group" aria-label={t('templates.builtIn')}>
      <div className="builtin-title">{t('templates.builtIn')}</div>
      {STARTER_TEMPLATES.map((template) => (
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
          onClick={() => props.onUse(template.id)}
        >
          {t('templates.create')}
        </button>
        <button type="button" className="button" onClick={() => props.onEditCopy(template.id)}>
          {t('templates.editCopy')}
        </button>
      </div>
      <pre className="builtin-body" aria-label={t('templates.preview')}>
        {template.body}
      </pre>
    </section>
  )
}
