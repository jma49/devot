import type { messages as en } from '../en/share'

export const messages: Record<keyof typeof en, string> = {
  'share.sheet.title': 'Devot',
  'share.post': '发布',
  'share.cancel': '取消',
  'share.field.title': '标题',
  'share.field.text': '文本',
  'share.images.count': '图片：{count}',
  'share.images.skipped': '有些图片无法添加。',
  'share.error.title': '无法添加到 Devot',
  'share.error.empty': '请添加标题、文本、链接或图片。',
  'share.error.tooLarge': '内容太大，无法添加到 Devot。请减少图片数量。',
  'share.error.save': 'Devot 无法保存这些内容，请重试。',
  'share.ok': '好',
}
