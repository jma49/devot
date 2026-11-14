import type { messages as en } from '../en/app'

export const messages: Record<keyof typeof en, string> = {
  'dialog.cancel': '取消',
  'dialog.save': '保存',
  'failure.offline': 'Devot 无法连接。请检查网络连接后重试。',
  'failure.timeout': '耗时太久。请重试。',
  'failure.addressRefused': 'Devot 不会连接到这个地址。',
  'failure.serverRefused': '服务器拒绝了请求。',
  'failure.serverUnavailable': '服务器现在不可用。请稍后再试。',
  'notice.undo': '撤销',
  'notice.dismiss': '忽略',
  'save.failedOne': '有 {count} 篇笔记的修改未能保存。Devot 会继续尝试。',
  'save.failedOther': '有 {count} 篇笔记的修改未能保存。Devot 会继续尝试。',
  'save.quitHeldOne':
    'Devot 没有退出：有 {count} 篇笔记的修改未能保存。它会继续尝试；再次退出将放弃这些修改。',
  'save.quitHeldOther':
    'Devot 没有退出：有 {count} 篇笔记的修改未能保存。它会继续尝试；再次退出将放弃这些修改。',
  'save.closeHeldOne':
    '窗口没有关闭：有 {count} 篇笔记的修改未能保存。Devot 会继续尝试；再次关闭将放弃这些修改。',
  'save.closeHeldOther':
    '窗口没有关闭：有 {count} 篇笔记的修改未能保存。Devot 会继续尝试；再次关闭将放弃这些修改。',
  'noteWindow.unavailable': '无法打开这篇笔记。它可能已被删除。',
  'noteWindow.trashed':
    '这篇笔记在废纸篓中，所以此窗口无法保存修改。在 Devot 中恢复它即可再次编辑。',
  'noteWindow.purged':
    '这篇笔记已被永久删除，所以此窗口无法保存修改。它的文字会以只读方式留在这里。',
  'save.retry': '重试',
  'start.failed': 'Devot 无法载入你的笔记。',
  'start.detail': '选择“帮助 > 导出诊断信息…”可以保存一份可分享的报告。',
  'start.retry': '重试',
  'core.failed': 'Devot 内部出了问题。如果修改不再保存，请退出并重新打开 Devot。',
  'change.failed': '无法进行这项更改。',
  'change.tagNameTaken': '已有其他标签使用这个名称。',
  'change.tagNameInvalid': '标签名称须为一行，最多 {max} 个字符。',
  'change.tagRenameSearchTooLong':
    '这个标签不能使用这个名称：使用它的一个已存搜索会超过 {max} 个字符。请缩短名称或编辑那个搜索。',
  'change.noteNotTrashed':
    '这篇笔记已不在废纸篓中，所以没有删除。它可能已在另一个窗口或另一台设备上被恢复。',
  'change.licenceRequired': '添加许可证之前笔记为只读，所以没有进行这项更改。',
  'change.bookNameInvalid': '笔记本名称须为一行，最多 {max} 个字符。',
}
