import type { messages as en } from '../en/files'

export const messages: Record<keyof typeof en, string> = {
  'pageSetup.title': '页面设置',
  'pageSetup.paper': '纸张',
  'pageSetup.paper.a4': 'A4',
  'pageSetup.paper.letter': 'US Letter',
  'pageSetup.paper.a4Landscape': 'A4 横向',
  'pageSetup.paper.slide': '幻灯片（16:9）',
  'pageSetup.margins': '页边距',
  'pageSetup.margins.narrow': '窄',
  'pageSetup.margins.normal': '常规',
  'pageSetup.margins.wide': '宽',
  'pageSetup.header': '页眉',
  'pageSetup.footer': '页脚',
  'pageSetup.left': '左',
  'pageSetup.center': '中',
  'pageSetup.right': '右',
  'pageSetup.fields':
    '在页眉和页脚中，{title} 是笔记标题，{page} 是页码，{total} 是总页数，{date} 是今天的日期。',
  'pageSetup.skipFirst': '第一页不显示',
  'pageSetup.rules': '页眉下方和页脚上方显示细线',
  'pageSetup.print': '打印…',
  'pageSetup.export': '导出…',
  'templates.new': '新建模板',
  'templates.pickTitle': '从模板新建笔记',
  'templates.filter': '筛选模板',
  'templates.recent': '最近使用',
  'templates.builtIn': '内置',
  'templates.builtInHint': '内置模板为只读。编辑一份副本即可做成你自己的模板。',
  'templates.starter.brainstorming.title': '头脑风暴',
  'templates.starter.brainstorming.body': `> # !说明
> 在“目标”下写下主题，然后列出所有想法，先不做评判。
> 把想法分组，挑出最好的几个，并为每个写下下一步。

# {{title}}

## 目标

## 想法

- 

## 分组

## 下一步

- [ ] 
`,
  'templates.starter.debugging.title': '调试',
  'templates.starter.debugging.body': `> # !说明
> 描述你预期的结果和实际发生的情况，然后记录每次尝试
> 以及它说明了什么。最后写下原因和修复方法。

# {{title}}

## 预期行为

## 实际行为

## 复现步骤

1. 

## 尝试

- 

## 原因

## 修复

- [ ] 
`,
  'templates.starter.learning.title': '学习',
  'templates.starter.learning.body': `> # !说明
> 记下来源和你想学的内容。用自己的话写下要点，
> 然后是问题，最后写一段足以讲给别人听的简短总结。

# {{title}}

## 来源

## 我想学什么

## 要点

- 

## 问题

- 

## 总结
`,
  'templates.starter.planning.title': '计划',
  'templates.starter.planning.body': `> # !说明
> 写明目标结果及其意义。把它拆成任务，写上负责人和日期，
> 并列出可能出问题的地方。

# {{title}}

## 目标结果

## 为什么重要

## 任务

- [ ] 

## 时间线

## 风险
`,
  'templates.starter.daily-report.title': '日报',
  'templates.starter.daily-report.body': `---
title: 日报 {{date}}
---

> # !说明
> 每天结束时填写。用这个模板新建的每篇笔记中，{{date}} 都会替换为当天的日期。

# {{title}}

## 今日完成

- 

## 进行中

- 

## 阻碍

- 

## 明日计划

- [ ] 
`,
  'templates.editCopy': '编辑副本',
  'templates.noMatches': '没有匹配的模板。',
  'templates.create': '创建',
  'templates.chooseTitle': '选择模板',
  'templates.use': '使用模板',
  'templates.preview': '预览',
  'templates.notebook': '笔记本：{name}',
  'templates.tags': '标签：{tags}',
  'templates.status': '状态：{status}',
  'templates.editorHint':
    '模板。front matter 设定用它新建的笔记的标题、笔记本、标签和状态；{{date}}、{{time}}、{{title}} 和 {{uuid}} 会自动填入。以 ! 标题开头的引用不会出现在这些笔记中。',
  'mirror.title': 'Markdown 镜像',
  'mirror.detail':
    'Devot 会让一个文件夹始终保持最新，每篇笔记对应一个 Markdown 文件，结构与导出相同，方便其他应用和工具读取你的笔记。',
  'mirror.notReadBack':
    '这个文件夹由 Devot 写入：在那里做的修改不会被读回。在那里改过的文件会以新名称保留，Devot 会写入自己的版本。',
  'mirror.off': '镜像已关闭。',
  'mirror.folderLabel': '文件夹',
  'mirror.chooseFolder': '选择文件夹…',
  'mirror.turnOff': '关闭',
  'mirror.includeAttachments': '包括附件',
  'mirror.includeAttachmentsHint': '关闭时，图片仍链接到附件文件夹，但不会在那里写入副本。',
  'mirror.size': '占用空间：{size}',
  'mirror.paused': '镜像已暂停。文件夹可以再次写入后会自动恢复。',
  'mirror.pausedMissing': '镜像已暂停：找不到它的文件夹。文件夹回来后会自动恢复。',
  'mirror.pausedReadOnly': '镜像已暂停：无法写入它的文件夹。可以写入后会自动恢复。',
  'mirror.pausedManifestMissing':
    '镜像已暂停：Devot 在文件夹中写入的文件列表（.devot-mirror.json）不见了。把它放回去，或重新选择文件夹以继续。',
  'mirror.pausedManifestInvalid':
    '镜像已暂停：无法读取 Devot 在文件夹中写入的文件列表（.devot-mirror.json）。重新选择文件夹以继续。',
  'mirror.pausedManifestForeign':
    '镜像已暂停：它的文件夹里是另一个 Devot 资料库的文件。重新选择文件夹以继续。',
  'mirror.chooseFailed': '无法使用这个文件夹。',
  'mirror.changeFailed': '无法保存镜像设置。',
  'mirror.confirm': '将“{name}”用作 Markdown 镜像？',
  'mirror.confirmDetail':
    '这个文件夹不是空的。Devot 会把自己的文件放在已有文件旁边，绝不更改或删除不是它写入的文件；内容与 Devot 将要写入的完全相同的文件会被视为 Devot 的文件。',
  'mirror.confirmUse': '使用文件夹',
  'mirror.keptOne': '一个在 Devot 外修改过的文件已以新名称保留：{files}。',
  'mirror.keptOther': '{count} 个在 Devot 外修改过的文件已以新名称保留：{files}。',
  'mirror.keptMore': '另外 {count} 个',
  'backups.title': '备份',
  'backups.detail': 'Devot 每天备份你的笔记，并保留最近 7 份备份。',
  'backups.empty': '还没有备份。',
  'backups.now': '立即备份',
  'backups.done': '完成',
  'backups.restore': '恢复…',
  'backups.restoreLabel': '恢复 {date} 的备份',
  'backups.unverified': '未验证的副本',
  'backups.confirmRestore': '恢复 {date} 的备份？',
  'backups.confirmRestoreDetail':
    '当前的笔记会被替换。Devot 会先备份它们，所以你可以再回到现在的状态。',
  'backups.confirm': '恢复',
  'backups.failed': '备份失败。',
  'backups.listFailed': '无法列出备份。',
  'backups.restoreFailed': '无法恢复备份。',
  'backups.restoreWindows': '没有恢复备份：另一个 Devot 窗口没能及时准备好。请重试。',
  'backups.restoreSyncOn': '同步打开时无法恢复备份：下一次同步会把之后的修改带回来。',
  'backups.autoFailed': '自动备份失败。',
  'backups.show': '显示备份',
  'searchIndex.rebuilding': '正在重建搜索索引…',
  'searchIndex.rebuiltOne': '已重建搜索索引（{count} 篇笔记）。',
  'searchIndex.rebuiltOther': '已重建搜索索引（{count} 篇笔记）。',
  'searchIndex.failed': '无法重建搜索索引。',
  'export.failed': '导出没有完成。',
  'export.partial': '导出不完整：已写入 {written}，{problems} 有问题。',
  'export.allName': 'Devot 笔记',
  'export.selectionName': 'Devot 导出',
  'export.printFailed': '无法打印这篇笔记。',
  'export.copyFailed': '无法拷贝这篇笔记。',
  'export.copyLinkFailed': '无法拷贝笔记链接。',
  'export.copyLinksFailed': '无法拷贝笔记链接。',
  'export.copyIdFailed': '无法拷贝 ID。',
  'import.title': '导入 Markdown 文件夹',
  'import.title.folders': '导入 Markdown 文件夹',
  'import.title.markdown': '导入 Markdown 文件',
  'import.title.html': '导入 HTML 文件',
  'import.scanning': '正在查看“{name}”…',
  'import.scanLabel': '扫描进度',
  'import.scanFound': '目前已找到 {files}和{images}',
  'import.found': '找到 {files}和{images}（{size}）。',
  'import.mapping.folder':
    '顶层的文件会放进你接下来选择的笔记本；每个含有笔记的文件夹都会成为其中的一个笔记本。',
  'import.mapping.folders':
    '每个文件夹都会成为你接下来选择的笔记本中的一个笔记本，其子文件夹嵌套在里面。',
  'import.treeLabel': '找到的文件夹',
  'import.folderCounts': '{files} · {images} · {size}',
  'import.notebookBadge': '笔记本',
  'import.treeSummary': '{books} · {notes}',
  'import.willSkip': '将被跳过',
  'import.markdownOne': '{count} 个 Markdown 文件',
  'import.markdownOther': '{count} 个 Markdown 文件',
  'import.imageCountOne': '{count} 张图片',
  'import.imageCountOther': '{count} 张图片',
  'import.continue': '继续',
  'import.back': '返回',
  'import.import': '导入',
  'import.importInto': '导入到“{name}”',
  'import.destination': '导入到',
  'import.destinationDetail': '为 {notes}选择一个笔记本。',
  'import.destinationFilter': '筛选笔记本',
  'import.counts': '已导入 {imported} · 已跳过 {skipped} · 失败 {failed}',
  'import.reason.fileType': '不是所选类型的文件',
  'import.reason.cancelled': '扫描已取消。',
  'import.running': '正在导入“{name}”…',
  'import.progress': '{done}/{files}',
  'import.progressLabel': '导入进度',
  'import.summary': '已将 {notes}导入 {books}。',
  'import.summaryWithImages': '已将 {notes}导入 {books}。{images}',
  'import.summaryNoBooks': '已导入 {notes}。',
  'import.summaryNoBooksWithImages': '已导入 {notes}。{images}',
  'import.imagesOne': '{count} 张图片已作为附件添加。',
  'import.imagesOther': '{count} 张图片已作为附件添加。',
  'import.wikiLinks': '将 [[维基链接]] 转换为笔记链接和图片',
  'import.conventions': '从 front matter 和 #标签读取标签，并把 callout 转换为提示块',
  'import.unresolvedLinksOne': '{count} 个维基链接没有匹配到笔记或图片，已保留为文字。',
  'import.unresolvedLinksOther': '{count} 个维基链接没有匹配到笔记或图片，已保留为文字。',
  'import.empty': '在“{name}”中没有找到 Markdown 文件。',
  'import.problems': '未导入',
  'import.failed': '导入失败。',
  'import.done': '完成',
  'import.filesOne': '{count} 个文件',
  'import.filesOther': '{count} 个文件',
  'import.booksOne': '{count} 个笔记本',
  'import.booksOther': '{count} 个笔记本',
  'import.reason.tooLarge': '大于 10 MB',
  'import.reason.size': '为空或大于 10 MB',
  'import.reason.notUtf8': '不是 UTF-8 文本',
  'import.reason.notFound': '找不到文件',
  'import.reason.outside': '在导入的文件夹之外',
  'import.reason.type': '不是支持的图片格式',
  'import.reason.path': '隐藏文件或路径无效',
  'import.reason.unreadable': '无法读取',
  'import.reason.tooDeep': '嵌套的文件夹层级太多',
  'import.reason.name': '名称不是有效的文字',
  'import.reason.linkHidden': '指向隐藏文件或文件夹的链接',
  'import.reason.unlocated': '无法把它的链接改为导入的图片',
  'import.reason.htmlDropped': '已省略：笔记无法容纳的 HTML 内容',
  'import.reason.incomplete': '只导入了一部分；请检查这篇笔记',
  'import.reason.session': '导入在读取这个文件之前结束了',
  'import.reason.stopped': '导入在这个文件之前停止了',
  'import.reason.other': '无法导入',
  'import.reason.tooManyFiles': '这个文件夹中的 Markdown 文件超过 10,000 个。',
  'import.reason.folderTooLarge': '这个文件夹里的文件太多，无法导入。',
  'import.reason.folderInvalid': '无法读取这个文件夹。',
  'import.reason.foldersUnsupported': '在这台设备上无法导入文件夹。',
  'import.reason.trialEnded': 'Devot 试用期已结束，因此无法导入。请在“设置 > 许可证”中添加许可证。',
  'import.reason.licenceUnreadable':
    'Devot 无法从钥匙串读取许可证，因此现在无法导入。请查看“设置 > 许可证”。',
}
