import type { messages as en } from '../en/browserExtensions'

export const messages: Record<keyof typeof en, string> = {
  'browserExtensions.title': '浏览器扩展',
  'browserExtensions.hint':
    '只有已注册的扩展可以使用此 API。请从剪藏设置中拷贝来源地址。更改会立即生效。',
  'browserExtensions.empty': '尚未注册浏览器扩展。',
  'browserExtensions.origin': '扩展来源地址',
  'browserExtensions.add': '添加扩展',
  'browserExtensions.remove': '移除',
  'browserExtensions.removeOrigin': '移除 {origin}',
  'browserExtensions.invalid': '最多输入八个扩展来源地址，不能包含末尾斜杠、路径或端口。',
}
