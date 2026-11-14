import type { messages as en } from '../en/intents'

export const messages: Record<keyof typeof en, string> = {
  'intent.add.title': '添加到 Devot',
  'intent.add.description': '向 Devot 添加一篇笔记。下次打开 Devot 时，它会出现在你的笔记中。',
  'intent.field.title': '标题',
  'intent.field.text': '文本',
  'intent.field.link': '链接',
  'intent.added': '已添加到 Devot。',
  'intent.error.empty': '请添加标题、文本或链接。',
  'intent.error.link': '链接必须是网页地址。',
  'intent.error.tooLarge': '内容太长，无法添加到 Devot。',
  'intent.error.full': '等待处理的笔记太多。请打开 Devot 后再试。',
  'intent.error.save': 'Devot 无法保存这些内容，请重试。',
  'intent.today.title': '打开今天的笔记',
  'intent.today.description': '在 Devot 中打开今天的笔记。',
}
