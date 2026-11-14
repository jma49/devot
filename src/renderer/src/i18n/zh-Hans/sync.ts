import type { messages as en } from '../en/sync'

export const messages: Record<keyof typeof en, string> = {
  'syncSettings.title': '同步',
  'syncSettings.detail':
    '同步通过你自己运行的中继，让笔记、笔记本、标签和图片在你的各台设备上保持一致。所有内容在离开这台设备之前都会加密：中继永远看不到任何标题或笔记。',
  'syncSettings.relay': '中继',
  'syncSettings.relayHint': '中继的地址，即部署时输出的地址。',
  'syncSettings.relayPlaceholder': 'https://',
  'syncSettings.relayJoinHint': '只有输入代码时才需要。粘贴的链接本身就带有中继地址。',
  'syncSettings.secret': '中继密钥',
  'syncSettings.secretHint':
    '中继自身的密钥（RELAY_SECRET），只在那里创建保险库时询问一次，不会保存在这台设备上。',
  'syncSettings.secretAgainHint':
    '这台设备上有一个中继不认识的保险库。输入一次中继密钥即可在那里创建它；密钥不会保存。',
  'syncSettings.secretRevokedHint':
    '这台设备已从保险库中移除。输入一次中继密钥即可重新登录；密钥不会保存。',
  'syncSettings.createVault': '创建保险库',
  'syncSettings.connect': '连接',
  'syncSettings.vaultReady': '保险库已就绪，同步已打开。',
  'syncSettings.enabled': '同步这台设备',
  'syncSettings.enabledHint': '停止输入 3 秒后修改会发送到中继，输入时至少每 10 秒发送一次。',
  'syncSettings.status': '状态',
  'syncSettings.state.off': '已关闭。',
  'syncSettings.state.connecting': '正在连接…',
  'syncSettings.state.syncing': '正在同步…',
  'syncSettings.state.idle': '已是最新。',
  'syncSettings.state.offline': '离线；正在重试。',
  'syncSettings.state.paused': '已暂停。',
  'syncSettings.state.stopped': '已停止。',
  'syncSettings.stoppedRevoked': '这台设备已从同步中移除。你的笔记保留在这台设备上。',
  'syncSettings.lastSync': '上次同步：{time}。',
  'syncSettings.neverSynced': '尚未同步。',
  'syncSettings.tooLargeOne': '有 {count} 篇笔记对中继来说太大，只保留在这台设备上。',
  'syncSettings.tooLargeOther': '有 {count} 篇笔记对中继来说太大，只保留在这台设备上。',
  'syncSettings.skippedOne':
    '来自另一台设备的 {count} 处修改无法读取，已跳过。将 Devot 更新到最新版本即可带入。',
  'syncSettings.skippedOther':
    '来自其他设备的 {count} 处修改无法读取，已跳过。将 Devot 更新到最新版本即可带入。',
  'syncSettings.pausedUntil': '同步暂停到 {time}：中继已达到今天的配额。',
  'syncSettings.storageFull':
    '同步暂停到 {time}：中继的存储空间已满，新建和修改的笔记与图片没有同步。这台设备上的一切照常工作。请删除不再需要的图片或笔记，或换用更大的服务器。',
  'syncSettings.storageFullRetry': '同步正在重试；中继的存储空间曾经已满。',
  'syncSettings.resuming': '中继今天的配额已重置；同步即将恢复。',
  'syncSettings.upload': '已上传 {sent}/{total} 项。',
  'syncSettings.relayOutdated':
    '你的中继来自较早的版本，缺少配额上限或图片限制。请更新它：用新版本重新运行 wrangler deploy，或用新版本重启 Node 中继。',
  'syncSettings.filesFullOne':
    '有 {count} 张图片没有同步：中继已没有存放图片的空间。它保留在这台设备上，笔记照常同步。请删除不再需要的图片，或换用更大的服务器；之后它会重新发送。',
  'syncSettings.filesFullOther':
    '有 {count} 张图片没有同步：中继已没有存放图片的空间。它们保留在这台设备上，笔记照常同步。请删除不再需要的图片，或换用更大的服务器；之后它们会重新发送。',
  'syncSettings.filesOutdatedOne':
    '有 {count} 张图片没有同步：你的中继太旧，无法存放图片。请更新它：用新版本重新运行 wrangler deploy，或用新版本重启 Node 中继。',
  'syncSettings.filesOutdatedOther':
    '有 {count} 张图片没有同步：你的中继太旧，无法存放图片。请更新它：用新版本重新运行 wrangler deploy，或用新版本重启 Node 中继。',
  'syncSettings.urlFailed': '无法保存中继地址。',
  'syncSettings.vaultFailed': '无法创建保险库。',
  'syncSettings.changeFailed': '无法打开或关闭同步。',
  'syncSettings.recovery': '恢复密钥',
  'syncSettings.recoveryHint':
    '请把这个密钥存进密码管理器，或打印出来。有了它和中继地址，即使没有其他设备了，新设备也能加入你的保险库。你确认已保存后，Devot 不会再显示它。',
  'syncSettings.recoveryCopy': '拷贝',
  'syncSettings.recoveryCopied': '已拷贝恢复密钥。90 秒后会从剪贴板中清除。',
  'syncSettings.recoverySaved': '我已保存',
  'syncSettings.copyFailed': '无法拷贝恢复密钥。',
  'syncSettings.recoverySaveFailed': 'Devot 无法记录密钥已保存。',
  'syncSettings.setup': '设置同步',
  'syncSettings.setupHint': '这是你同步的第一台设备，还是要把它加入另一台设备已在同步的笔记？',
  'syncSettings.setupFirst': '这是我的第一台设备',
  'syncSettings.setupAnother': '我要添加另一台设备',
  'syncSettings.setupChange': '更改回答',
  'syncSettings.firstHint':
    'Devot 会在中继（一台你自己运行的小型服务器）上创建你的保险库，并给你一个需要妥善保管的恢复密钥。请输入中继地址，然后输入它的密钥。',
  'syncSettings.anotherHint':
    '在已经同步的设备上打开“设置 > 同步”，选择“显示配对码”。在这里扫描二维码，或输入或粘贴配对码或链接。加入会把这台设备添加到那个保险库，绝不会另建一个。',
  'syncSettings.usage.title': '存储空间',
  'syncSettings.usage.records': '笔记和其他记录',
  'syncSettings.usage.images': '图片',
  'syncSettings.usage.total': '总计',
  'syncSettings.usage.room': '剩余空间',
  'syncSettings.usage.of': '{used}/{limit}',
  'syncSettings.usage.retry': '再次检查',
  'syncSettings.usage.reading': '正在读取中继存放的内容…',
  'syncSettings.usage.offline':
    '无法连接中继，所以不显示它的存储空间。能再次连接中继时会显示在这里。',
  'syncSettings.usage.old': '你的中继来自较早的版本，无法报告存储空间。更新它即可查看剩余空间。',
  'syncSettings.usage.failed': '无法读取中继的存储空间。',
  'syncSettings.usage.roomImages': '{room}。其中图片可使用 {images}。',
  'syncSettings.usage.roomImagesUsed': '{room}。图片已用完它们的份额，因此只有笔记可以使用。',
  'syncSettings.usage.roomNone': '没有剩余空间。新建和修改的笔记与图片会等到你腾出空间。',
  'syncSettings.usage.noCap': '没有上限。这个中继没有设定存储上限，只受它自己的磁盘限制。',
  'syncSettings.usage.unknownCap': '未知。这个中继没有说明它能存放多少。',
  'syncSettings.usage.capNote':
    '这个中继总共最多存放 {limit}，其中图片最多 {images}，所以笔记始终有空间。',
  'syncSettings.usage.capNoteTotal': '这个中继总共最多存放 {limit}。',
  'syncSettings.pair': '添加设备',
  'syncSettings.pairHint':
    '在这里显示一个配对码，然后用新设备的相机扫描它，或拷贝链接并在新设备的“用代码加入”中粘贴。只有代码时，还需要在那里输入中继地址。配对码只能用一次，有效期 10 分钟。',
  'syncSettings.pairShow': '显示配对码',
  'syncSettings.pairCopyLink': '拷贝链接',
  'syncSettings.pairLinkCopied':
    '已拷贝配对链接。它带有中继地址，只能用一次，有效期 10 分钟，90 秒后会从剪贴板中清除。',
  'syncSettings.pairCopyFailed': '无法拷贝配对链接。',
  'syncSettings.pairQr': '用于配对设备的二维码',
  'syncSettings.pairCode': '配对码',
  'syncSettings.pairExpiresIn': '{time}后过期。',
  'syncSettings.pairWaiting': '正在等待另一台设备…',
  'syncSettings.pairTaken': '有设备正在加入…',
  'syncSettings.pairDone': '一台新设备加入了保险库。',
  'syncSettings.pairExpired': '配对码已过期。请显示一个新的再试。',
  'syncSettings.pairRetrying': '无法连接中继。正在重试…',
  'syncSettings.pairUnconfirmed':
    '有一台设备取走了这个配对码，但没有完成加入。如果那不是你的设备，可能有人持有这个保险库的密钥，之后可能会加入：请检查“设备”并移除你不认识的设备。',
  'syncSettings.pairFailed': '无法显示配对码。',
  'syncSettings.pairCheckFailed': '配对已停止。',
  'syncSettings.joinCode': '用代码加入',
  'syncSettings.joinCodeHint':
    '你的另一台设备在“添加设备”中显示的配对码，或其二维码中的链接。链接带有中继地址；只有代码时，请先在下方输入中继地址。',
  'syncSettings.joinRecovery': '用恢复密钥加入',
  'syncSettings.joinRecoveryHint': '你打开同步时保存的恢复密钥，加上上方的中继地址。',
  'syncSettings.join': '加入',
  'syncSettings.linkRelayConfirm': '通过 {host} 上的中继同步？',
  'syncSettings.linkRelayDetail':
    '粘贴的链接指定了这个中继。你的笔记会加密后经由它传输，所以只有在它是你自己的中继时才继续。',
  'syncSettings.linkRelayButton': '使用这个中继',
  'syncSettings.joined': '这台设备已加入保险库，同步已打开。',
  'syncSettings.joinFailed': '这台设备无法加入保险库。',
  'syncSettings.devices': '设备',
  'syncSettings.devicesHint': '这个保险库中的设备。移除一台会让它停止同步；它上面的笔记会保留。',
  'syncSettings.devicesList': '这个保险库中的设备',
  'syncSettings.deviceAdded': '添加于 {date}',
  'syncSettings.thisDevice': '这台设备',
  'syncSettings.deviceRemove': '移除…',
  'syncSettings.deviceRemoveLabel': '移除 {name}（添加于 {date}）',
  'syncSettings.deviceRemoveConfirm': '从同步中移除 {name}（添加于 {date}）？',
  'syncSettings.deviceRemoveDetail':
    '那台设备会停止同步，它上面的笔记会保留。它仍持有这个保险库的密钥，所以在你更换保险库密钥之前，持有它的人仍可以重新加入。',
  'syncSettings.devicesNotJoinedHint':
    '这个保险库中的设备，以及尚未加入新密钥的旧密钥设备：用配对码或新的恢复密钥逐一加入。把丢失的设备从列表中移除。',
  'syncSettings.deviceNotJoined': '添加于 {date} · 尚未加入',
  'syncSettings.deviceNotJoinedRemoveDetail':
    '它会从这个列表中移除。旧密钥打不开任何新内容，所以它的笔记和这个保险库保持原样。',
  'syncSettings.deviceRemoveButton': '移除',
  'syncSettings.deviceRemoved': '已从同步中移除这台设备。',
  'syncSettings.devicesFailed': '无法列出设备。',
  'syncSettings.devicesRetry': '重试',
  'syncSettings.removeFailed': '无法移除这台设备。',
  'syncSettings.why.outdated':
    '你的中继早于配对功能：请更新它（docs/sync-relay.md 中的 Update the relay）。在此期间可以使用恢复密钥。',
  'syncSettings.why.otherVault': '这台设备已经有另一个保险库，Devot 绝不会替换它。',
  'syncSettings.why.codeGone': '这个配对码已被使用、取消或已过期。请在另一台设备上显示一个新的。',
  'syncSettings.why.codeMistyped': '请检查配对码：它看起来不是配对码。',
  'syncSettings.why.codeRefused': '中继交来的内容无法用这个配对码打开，所以没有保留任何东西。',
  'syncSettings.why.otherRelay': '这个配对码属于另一个中继，而不是上方设定的中继。',
  'syncSettings.why.keyMistyped': '请检查密钥：它看起来不是恢复密钥。',
  'syncSettings.why.noRelay': '请先在上方输入中继地址。',
  'syncSettings.why.noVault': '上方设定的中继没有这个保险库。请检查它的地址。',
  'syncSettings.why.relayInvalid':
    '中继地址以 https:// 开头（只有这台电脑上的中继可以用 http://）。',
  'syncSettings.why.relaySecret': '中继不接受这个密钥。请检查中继上的 RELAY_SECRET。',
  'syncSettings.why.relaySecretInvalid': '中继密钥为空，或含有它不能接受的字符。请重新粘贴。',
  'syncSettings.why.unreachable': '无法连接中继，或它返回了错误。请检查网络连接和上方的中继地址。',
  'syncSettings.why.keychain': '钥匙串不允许 Devot 保存这个保险库的密钥。请允许访问后重试。',
  'syncSettings.why.tooManyDevices':
    '保险库已达到设备上限。请在另一台设备上移除一台不再使用的设备，然后重试。',
  'syncSettings.why.enrollDenied': '中继拒绝了这台设备：这个密钥或配对码属于另一个保险库。',
  'syncSettings.icloudDetail':
    '你的笔记通过 iCloud 在登录同一 Apple 账户的设备之间同步。Devot 会在笔记离开这台设备之前加密，所以 Apple 无法读取。',
  'syncSettings.enabledHintIcloud':
    '停止输入 3 秒后修改会发送到 iCloud，输入时至少每 10 秒发送一次。',
  'syncSettings.transport': '同步方式',
  'syncSettings.transportIcloud': 'iCloud，笔记在离开这台设备之前由 Devot 加密。',
  'syncSettings.transportRelay': '你自己运行的中继。',
  'syncSettings.transportQuestionHint':
    '使用 iCloud 无需任何设置：登录你 Apple 账户的设备会自己找到你的保险库。Devot 会在笔记离开这台设备之前加密。',
  'syncSettings.useIcloud': '通过 iCloud 同步',
  'syncSettings.transportRelayAdvanced': '使用我自己的中继',
  'syncSettings.useIcloudInstead': '改用 iCloud',
  'syncSettings.icloudUnavailableBuild':
    '这个版本的 Devot 无法通过 iCloud 同步。请在这里关闭同步，或使用 Devot 的正式版本。',
  'syncSettings.icloudSignedOut':
    '请在“系统设置”中登录 iCloud 以通过它同步。在此期间你的笔记保留在这台设备上。',
  'syncSettings.icloudRestricted':
    '这台设备上的 iCloud 受到“屏幕使用时间”或设备管理者的限制，所以 Devot 无法通过它同步。你的笔记保留在这台设备上。',
  'syncSettings.icloudTemporarilyUnavailable':
    'iCloud 现在不可用。Devot 会自动重试，在此期间你的笔记保留在这台设备上。',
  'syncSettings.icloudFull':
    '你的 iCloud 存储空间已满，所以这台设备上的修改没有同步。请在“系统设置 > Apple 账户 > iCloud”中释放或购买更多 iCloud 存储空间；之后同步会自动继续。',
  'syncSettings.icloudPausedUntil': '同步暂停到 {time}：iCloud 要求 Devot 等待。',
  'syncSettings.resumingICloud': 'iCloud 重新接受修改；同步即将恢复。',
  'syncSettings.icloudAccountChanged':
    '这台设备现在登录的 Apple 账户与这个保险库同步所用的不同。请把保险库移到这个 Apple 账户，或关闭同步。',
  'syncSettings.icloudMoveToThisAccount': '移到这个 Apple 账户',
  'syncSettings.icloudMoveConfirm': '把这个保险库移到当前登录的 Apple 账户？',
  'syncSettings.icloudMoveDetail':
    '这台设备会把所有笔记上传到那里。另一个 Apple 账户上的设备会停止与这台设备同步，直到它们也登录这个 Apple 账户并移过来。',
  'syncSettings.icloudMoveButton': '移动',
  'syncSettings.icloudDeleted':
    '这个保险库的数据已从 iCloud 中删除，可能是在 iCloud 存储空间管理中删除的。请从这台设备重新上传，或关闭同步。',
  'syncSettings.icloudUploadAgain': '重新上传',
  'syncSettings.icloudUploadConfirm': '把这个保险库重新上传到 iCloud？',
  'syncSettings.icloudUploadDetail':
    '这台设备会上传它的所有笔记。你的其他设备下次同步时会重新加入。',
  'syncSettings.icloudUploadButton': '上传',
  'syncSettings.turnOff': '关闭同步',
  'syncSettings.icloudJoined': '这台设备通过 iCloud 钥匙串找到了你的保险库并已加入。同步已打开。',
  'syncSettings.icloudJoinAsk':
    '你的 Apple 账户已在同步一个 Devot 保险库。要加入吗？这里的 {count} 篇笔记会放进去，并同步到你的其他设备。',
  'syncSettings.icloudJoin': '加入',
  'syncSettings.icloudDecline': '以后再说',
  'syncSettings.icloudDeclined':
    '你的 Apple 账户在同步一个 Devot 保险库，你选择了暂不加入。随时可以加入。',
  'syncSettings.icloudKeychainMissing':
    '你的 Apple 账户在同步一个 Devot 保险库，但它的密钥还没有通过 iCloud 钥匙串到达这台设备。请用你某台设备上的配对码或恢复密钥加入。',
  'syncSettings.icloudOtherItem':
    'iCloud 钥匙串中保存的是另一个保险库的密钥，而不是你的 Apple 账户正在同步的那个。请用你某台设备上的配对码或恢复密钥加入。',
  'syncSettings.icloudOtherAccount':
    '这个配对码来自登录了另一个 Apple 账户的设备。请在登录这个账户的设备上显示配对码，或在这里登录那个 Apple 账户。',
  'syncSettings.icloudStorage': '存储在 iCloud 中',
  'syncSettings.icloudStorageValue': '约 {size}，根据这个保险库同步的笔记和图片计算。',
  'syncSettings.icloudStorageReading': '正在计算保险库存放的内容…',
  'syncSettings.icloudStorageFailed': '无法计算保险库存放的内容。',
  'syncSettings.icloudStorageManaged':
    '你的 iCloud 存储空间及剩余容量在“系统设置 > Apple 账户 > iCloud”中管理。',
  'syncSettings.icloudDevicesHint':
    '通过你的 Apple 账户同步这个保险库的设备，以及每台设备最后出现的日期。已退出登录的设备仍会列出。',
  'syncSettings.deviceSeen': '最后出现于 {date}',
  'syncSettings.icloudDevicesUnseenHint':
    '通过你的 Apple 账户同步这个保险库的设备，以及每台设备最后出现的日期。尚未使用 iCloud 的设备仍需跟随迁移：在它上面打开“设置 > 同步”。',
  'syncSettings.deviceUnseen': '添加于 {date} · 尚未使用 iCloud',
  'syncSettings.vaultMoved': '这个保险库已在你的另一台设备上移到 iCloud。',
  'syncSettings.vaultMovedHint': '跟随它即可在这里继续同步。',
  'syncSettings.vaultMovedElsewhere': '重新设置同步即可跟随它。',
  'syncSettings.vaultMovedFollow': '跟随到 iCloud',
  'syncSettings.vaultMovedHere': '这个保险库迁移到 iCloud 的过程在这台设备上开始，但没有完成。',
  'syncSettings.vaultMovedHereHint': '完成迁移即可在这里继续同步。',
  'syncSettings.vaultMovedFinish': '完成迁移到 iCloud',
  'syncSettings.switchTransport': '移到 iCloud',
  'syncSettings.switchTransportHint': '让这个保险库改为通过 iCloud 而不是中继同步。',
  'syncSettings.switchTransportConfirm': '把这个保险库从中继移到 iCloud？',
  'syncSettings.switchTransportDetail':
    '这台设备会把所有笔记上传到 iCloud，并在中继上留下通知。你的其他设备下次同步时会跟随。',
  'syncSettings.switchTransportButton': '移动',
  'syncSettings.rotate': '更换保险库密钥',
  'syncSettings.rotateHint':
    '把仍持有密钥的丢失或已移除设备拒之门外。你的笔记会移到一个新保险库，你的其他设备需要用配对码或新的恢复密钥重新加入。',
  'syncSettings.rotateSecretHint': '输入中继密钥以创建新保险库。它只使用一次，不会保存。',
  'syncSettings.rotateButton': '更换密钥',
  'syncSettings.rotateFailed': '无法更换保险库密钥。',
  'syncSettings.rotateIcloudHint':
    '把仍持有密钥的丢失设备拒之门外。你的笔记会移到一个新保险库，这个 Apple 账户上的设备会自动跟随。',
  'syncSettings.rotateIcloudWarning':
    '仍登录这个 Apple 账户并使用 iCloud 钥匙串的设备也会收到新密钥。请先从你的 Apple 账户中移除丢失的设备，再更换密钥。',
  'syncSettings.rotatedAwayIcloud':
    '保险库密钥已在另一台设备上更换，新密钥还没有通过 iCloud 钥匙串到达这台设备。要再次同步，请输入持有新密钥的设备上的配对码，或新的恢复密钥。你的笔记保留在这里。',
  'syncSettings.rotated': '保险库密钥已更换。请保存新的恢复密钥，然后让你的其他设备重新加入。',
  'syncSettings.rotatedIcloud':
    '保险库密钥已更换。请保存新的恢复密钥；这个 Apple 账户上的设备会自动跟随。',
  'syncSettings.rotatedIcloudFollowed':
    '另一台设备先更换了保险库密钥。这台设备现在使用它的新密钥；新的恢复密钥显示在那台设备上。',
  'syncSettings.rotatedAway':
    '保险库密钥已在另一台设备上更换。要再次同步，请输入持有新密钥的设备上的配对码，或新的恢复密钥。你的笔记保留在这里。',
  'syncSettings.why.rotated':
    '这个密钥已被更换。请使用持有新密钥的设备上的配对码，或新的恢复密钥。',
  'syncSettings.icloudChangeFailed': '无法更改 iCloud 同步。',
  'syncSettings.leave': '离开这个保险库',
  'syncSettings.leaveHint':
    '在这台设备上忘记这个保险库的密钥，之后它可以用配对码或恢复密钥重新加入保险库。你的笔记保留在这台设备上。',
  'syncSettings.leaveConfirm': '让这台设备离开这个保险库？',
  'syncSettings.leaveDetail':
    '保险库密钥和这台设备访问中继的权限会从这台设备上移除，同步随之关闭。你的笔记保留在这里。中继和你的其他设备不会有任何变化，它们会一直列出这台设备，直到你在那里移除它。',
  'syncSettings.leaveButton': '离开',
  'syncSettings.left': '你已离开保险库。你的笔记保留在这里。要再次同步，请用配对码或恢复密钥加入。',
  'syncSettings.leaveFailed': '无法离开保险库。',
  'syncSettings.icloudLeave': '离开这个保险库',
  'syncSettings.icloudLeaveHint':
    '从这个 Apple 账户中移除保险库。你的笔记保留在每台设备上，其他设备再次同步前会先询问。如果只想暂停同步并保留保险库，请关闭同步。',
  'syncSettings.icloudLeaveKey': '恢复密钥',
  'syncSettings.icloudLeaveKeyHint':
    '输入这个保险库的恢复密钥以离开它。在你这样做之前，iCloud 中的任何内容都不会被删除。',
  'syncSettings.icloudLeaveButton': '离开这个保险库',
  'syncSettings.icloudLeft': '已从 iCloud 中移除保险库。你的笔记保留在这里。',
  'syncSettings.icloudLeaveFailed': '无法离开保险库。',
  'syncSettings.pairHintIcloud':
    '只用于没有通过 iCloud 钥匙串自动加入的设备。在这里显示配对码，然后在新设备上扫描它。配对码只能用一次，有效期 10 分钟。',
  'syncSettings.joinCodeIcloudHint':
    '这个 Apple 账户上某台设备在“添加设备”中显示的配对码，或其二维码中的链接。',
  'syncSettings.joinRecoveryIcloudHint': '你第一次打开同步时保存的恢复密钥。',
  'syncSettings.recoveryHintIcloud':
    '请把这个密钥存进密码管理器，或打印出来。有了它，即使没有其他设备了，登录你 Apple 账户的设备也能加入你的保险库。你确认已保存后，Devot 不会再显示它。',
  'syncSettings.why.icloudBusy': 'iCloud 正忙。请几分钟后再试。',
  'syncSettings.why.icloudOtherVault':
    '你的 Apple 账户已在同步另一个保险库，Devot 绝不会替换它。请改用它某台设备上的配对码加入。',
  'syncSettings.why.icloudLeaving': '那个保险库正在另一台设备上从这个 Apple 账户的 iCloud 中移除。',
  'syncSettings.why.icloudNoVault':
    '你的 Apple 账户没有同步这个密钥对应的保险库。请确认这台设备登录的是同步它的 Apple 账户。',
  'syncSettings.why.icloudNotUsed': '这个保险库不是通过 iCloud 同步的。',
  'syncSettings.why.leaveOtherKey':
    '这是另一个保险库的恢复密钥。请输入这台设备正在同步的保险库的密钥。',
  'syncSettings.why.icloudFailed': 'iCloud 返回了错误。请稍后再试。',
  'syncSettings.why.icloudZoneMissing': '保险库的数据还不在 iCloud 中。请稍后重试。',
  'syncSettings.why.icloudRecordInvalid':
    'iCloud 中有这个版本的 Devot 无法读取的内容。请更新 Devot。',
  'syncSettings.why.icloudStaging':
    'Devot 无法在这台设备上为 iCloud 暂存图片。请检查磁盘是否还有空间。',
  'syncSettings.why.movedRefused':
    '中继没有接受告知其他设备保险库已迁移的通知，所以它仍通过中继同步。等中继有空间后再试。',
  'sync.notice.revoked': '这台设备已从同步中移除，同步已停止。你的笔记保留在这台设备上。',
  'sync.notice.clock':
    '同步已暂停：这台设备的时钟偏差超过 5 分钟。请设为自动设置日期与时间以重新同步。',
  'sync.notice.stopped':
    '同步已停止。在“设置 > 同步”中关闭再打开“同步这台设备”以重试，或重新设置这台设备。',
  'sync.notice.stoppedAdvice': '同步已停止。{advice}',
  'sync.advice.protocol': '请把 Devot 和你的中继更新到同一个版本。',
  'sync.advice.restoreChoice':
    '这里恢复了一份备份：请在主窗口中选择合并，还是保留这台 Mac 上的副本。',
  'sync.advice.moved': '这个保险库现在改用其他方式同步。请在“设置 > 同步”中重新设置以跟随它。',
  'sync.advice.rotated':
    '保险库密钥已在另一台设备上更换。请在“设置 > 同步”中用配对码或新的恢复密钥重新加入。',
  'sync.advice.circuit':
    '有一篇笔记在设备之间反复来回变化。请在“设置 > 同步”中关闭再打开“同步这台设备”以重试。',
  'sync.notice.storageFull':
    '同步暂停到 {time}：中继的存储空间已满，新建和修改的笔记与图片没有同步。来自其他设备的笔记仍会到达，这台设备上的一切照常工作。要再次同步，请删除不再需要的图片或笔记，或换用更大的服务器。',
  'sync.notice.storageFullRetry':
    '同步正在重试：中继的存储空间曾经已满。如果再次暂停，请删除不再需要的图片或笔记，或换用更大的服务器。',
  'sync.notice.usage.storageWarn':
    '中继的存储空间已用超过 80%。同步照常进行。为留出空间，请删除不再需要的图片或笔记，或换用更大的服务器。“设置 > 同步”会显示哪些内容占用了空间。',
  'sync.notice.usage.storageFull':
    '中继的存储空间已满，新建和修改的笔记与图片没有同步。来自其他设备的笔记仍会到达，这台设备上的一切照常工作。要再次同步，请删除不再需要的图片或笔记，或换用更大的服务器。',
  'sync.notice.usage.imagesWarn':
    '中继存放图片的空间已用超过 80%。笔记照常同步。为留出空间，请删除不再需要的图片，或换用更大的服务器。',
  'sync.notice.usage.imagesFull':
    '中继已没有存放图片的空间，所以新图片没有同步，保留在这台设备上。笔记照常同步。要同步图片，请删除不再需要的图片，或换用更大的服务器。',
  'sync.notice.licence':
    '同步已停止：它需要 Devot 许可证。你的笔记保留在这台设备上。请在“设置 > 许可证”中添加许可证。',
  'sync.notice.licenceTrialEnded':
    '同步已停止：试用期已结束，同步需要 Devot 许可证。你的笔记保留在这台设备上。请在“设置 > 许可证”中添加许可证。',
  'sync.notice.licenceUnreadable':
    '同步已停止：Devot 无法从钥匙串读取许可证。你的笔记保留在这台设备上。请查看“设置 > 许可证”。',
  'sync.notice.paused':
    '同步暂停到 {time}：中继已达到今天的配额。你的笔记在这台设备上照常工作，之后会同步。',
  'sync.notice.pausedUpload':
    '同步暂停到 {time}：中继已达到今天的配额，已上传 {sent}/{total} 项。之后上传会继续；你的笔记在这台设备上照常工作。',
  'sync.notice.resuming': '中继今天的配额已重置；同步即将恢复。你的笔记在这台设备上照常工作。',
  'sync.notice.resumingUpload':
    '中继今天的配额已重置；同步即将恢复，目前已上传 {sent}/{total} 项。',
  'sync.notice.tooLargeOne': '有 {count} 篇笔记太大，无法同步，只保留在这台设备上。',
  'sync.notice.tooLargeOther': '有 {count} 篇笔记太大，无法同步，只保留在这台设备上。',
  'sync.notice.icloudSignedOut':
    '同步已暂停：这台设备没有登录 iCloud。请在“系统设置”中登录 iCloud 以重新同步；你的笔记保留在这台设备上。',
  'sync.notice.icloudRestricted':
    '同步已暂停：这台设备上的 iCloud 受到“屏幕使用时间”或设备管理者的限制。你的笔记保留在这台设备上。',
  'sync.notice.icloudTemporarilyUnavailable':
    'iCloud 现在不可用。同步会自动重试；你的笔记在这台设备上照常工作。',
  'sync.notice.icloudFull':
    '同步已暂停：你的 iCloud 存储空间已满，所以这台设备上的修改没有同步。请在“系统设置 > Apple 账户 > iCloud”中释放或购买更多 iCloud 存储空间；之后同步会自动继续。',
  'sync.notice.icloudPausedUntil':
    '同步暂停到 {time}：iCloud 要求 Devot 等待。你的笔记在这台设备上照常工作。',
  'sync.notice.icloudAccountChanged':
    '同步已停止：这台设备登录的 Apple 账户与你的保险库在 iCloud 上同步所用的不同。请在“设置 > 同步”中把保险库移到这个 Apple 账户，或关闭同步。',
  'sync.notice.icloudDeleted':
    '同步已停止：你的保险库数据已从 iCloud 中删除。请在“设置 > 同步”中从这台设备重新上传，或关闭同步。',
  'sync.notice.icloudUnavailableBuild':
    '同步已停止：这个版本的 Devot 无法通过 iCloud 同步。请在“设置 > 同步”中关闭同步，或使用 Devot 的正式版本。',
  'sync.notice.vaultMoved':
    '同步已停止：你的保险库已在你的另一台设备上移到 iCloud。请在“设置 > 同步”中跟随它。',
  'sync.notice.vaultMovedHere':
    '同步已停止：你的保险库迁移到 iCloud 的过程在这台设备上开始，但没有完成。请在“设置 > 同步”中完成它。',
  'sync.notice.icloudJoined': '这台设备通过 iCloud 钥匙串找到了你的保险库并已加入。同步已打开。',
  'sync.notice.icloudJoinAsk':
    '你的 Apple 账户在同步一个 Devot 保险库。要带着这里的 {count} 篇笔记加入它，请打开“设置 > 同步”。',
  'sync.notice.icloudKeychainMissing':
    '你的 Apple 账户在同步一个 Devot 保险库，但它的密钥还没有到达这台设备。请在“设置 > 同步”中用配对码或恢复密钥加入。',
  'sync.notice.icloudOtherItem':
    'iCloud 钥匙串中保存的是另一个保险库的密钥，而不是你的 Apple 账户正在同步的那个。请在“设置 > 同步”中用配对码或恢复密钥加入。',
  'sync.restore.message': '同步从备份中恢复的笔记？',
  'sync.restore.detail':
    '“合并”会带回你的其他设备在备份之后所做的修改。“保留这台 Mac 上的副本”会让恢复的笔记在所有设备上替换它们。无论选哪个，在另一台设备上被永久删除的笔记都无法恢复。',
  'sync.restore.merge': '合并',
  'sync.restore.keep': '保留这台 Mac 上的副本',
}
