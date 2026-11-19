import type { PreviewLabels, PreviewNote } from '../../../core'
import { t } from '../i18n'

export function previewLabels(): PreviewLabels {
  return {
    alerts: {
      note: t('alert.note'),
      tip: t('alert.tip'),
      important: t('alert.important'),
      warning: t('alert.warning'),
      caution: t('alert.caution'),
    },
    embedFrom: t('embed.from'),
    embedLoad: t('embed.load'),
    videoTitle: t('embed.videoTitle'),
    untitled: t('note.untitled'),
    missingNote: t('preview.missingNote'),
    codeLines: t('preview.codeLines'),
    codeLine: t('preview.codeLine'),
    codeRef: t('preview.codeRef'),
    codeSource: t('preview.codeSource'),
  }
}

export type PreviewNoteFields = Omit<PreviewNote, 'labels'>

export function previewNote(fields: PreviewNoteFields): PreviewNote {
  return {
    ...fields,
    labels: {
      statuses: {
        none: t('status.none'),
        active: t('status.active'),
        on_hold: t('status.on_hold'),
        completed: t('status.completed'),
        dropped: t('status.dropped'),
      },
      noteValue: t('preview.frontMatterNote'),
      noTags: t('preview.frontMatterNoTags'),
      apply: t('preview.frontMatterApply'),
      applyTitle: t('preview.applyTitle'),
      applyStatus: t('preview.applyStatus'),
      applyTags: t('preview.applyTags'),
    },
  }
}
