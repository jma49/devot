import { STARTER_PREFIX, type StarterTemplate } from '../../core/starterTemplates'
import { t, type MessageKey } from './i18n'

const NAMES = ['brainstorming', 'debugging', 'learning', 'planning', 'daily-report'] as const

/** Read at use, so a locale set after start-up is the one shown. */
export const starterTemplates = (): readonly StarterTemplate[] =>
  NAMES.map((name) => ({
    id: `${STARTER_PREFIX}${name}`,
    title: t(`templates.starter.${name}.title` satisfies MessageKey),
    body: t(`templates.starter.${name}.body` satisfies MessageKey),
  }))

export const starterTemplate = (id: string): StarterTemplate | undefined =>
  starterTemplates().find((template) => template.id === id)
