export const prefixes = ['syncSettings', 'sync']

export const messages = {
  'syncSettings.title': 'Sync',
  'syncSettings.detail':
    'Sync keeps your notes, notebooks, tags and images the same on your devices, through a relay you run yourself. Everything is encrypted on this device before it leaves: the relay never sees a title or a note.',
  'syncSettings.relay': 'Relay',
  'syncSettings.relayHint': 'The address of your relay, as its deploy printed it.',
  'syncSettings.relayPlaceholder': 'https://',
  'syncSettings.relayJoinHint':
    'Needed only when you type a code. A pasted link carries the relay’s address itself.',
  'syncSettings.secret': 'Relay Secret',
  'syncSettings.secretHint':
    'The relay’s own secret (RELAY_SECRET), asked once to create your vault there. It is not kept on this device.',
  'syncSettings.secretAgainHint':
    'This device holds a vault the relay does not know. Enter the relay’s secret once to create it there; it is not kept.',
  'syncSettings.secretRevokedHint':
    'This device was removed from the vault. Enter the relay’s secret once to sign it back in; it is not kept.',
  'syncSettings.createVault': 'Create Vault',
  'syncSettings.connect': 'Connect',
  'syncSettings.vaultReady': 'The vault is ready and sync is on.',
  'syncSettings.enabled': 'Sync This Device',
  'syncSettings.enabledHint':
    'Changes go to the relay 3 seconds after you stop typing, and at least every 10 seconds while you type.',
  'syncSettings.status': 'Status',
  'syncSettings.state.off': 'Off.',
  'syncSettings.state.connecting': 'Connecting…',
  'syncSettings.state.syncing': 'Syncing…',
  'syncSettings.state.idle': 'Up to date.',
  'syncSettings.state.offline': 'Offline; trying again.',
  'syncSettings.state.paused': 'Paused.',
  'syncSettings.state.stopped': 'Stopped.',
  'syncSettings.stoppedRevoked':
    'This device was removed from sync. Your notes stay on this device.',
  'syncSettings.lastSync': 'Last synced {time}.',
  'syncSettings.neverSynced': 'Not synced yet.',
  'syncSettings.tooLargeOne': '{count} note is too large for the relay and stays on this device.',
  'syncSettings.tooLargeOther':
    '{count} notes are too large for the relay and stay on this device.',
  'syncSettings.skippedOne':
    '{count} change from another device could not be read and was skipped. Update Devot to the latest release to bring it in.',
  'syncSettings.skippedOther':
    '{count} changes from other devices could not be read and were skipped. Update Devot to the latest release to bring them in.',
  'syncSettings.pausedUntil':
    'Sync paused until {time}: the relay has reached its quota for today.',
  'syncSettings.storageFull':
    'Sync paused until {time}: the relay’s storage is full, so new and changed notes and images are not syncing. Everything still works on this device. Remove images or notes you no longer need, or use a larger server.',
  'syncSettings.storageFullRetry': 'Sync is trying again; the relay’s storage was full.',
  'syncSettings.resuming': 'The relay’s quota for today has reset; sync resumes in a moment.',
  'syncSettings.upload': '{sent} of {total} items uploaded.',
  'syncSettings.relayOutdated':
    'Your relay comes from an earlier release and lacks the quota cap or the limit for images. Update it: run wrangler deploy again from the new release, or restart the Node relay from it.',
  'syncSettings.filesFullOne':
    '{count} image is not synced: the relay has no room left for images. It stays on this device, and notes keep syncing. Remove images you no longer need, or use a larger server; it is sent again after that.',
  'syncSettings.filesFullOther':
    '{count} images are not synced: the relay has no room left for images. They stay on this device, and notes keep syncing. Remove images you no longer need, or use a larger server; they are sent again after that.',
  'syncSettings.filesOutdatedOne':
    '{count} image is not synced: your relay is too old to hold images. Update it: run wrangler deploy again from the new release, or restart the Node relay from it.',
  'syncSettings.filesOutdatedOther':
    '{count} images are not synced: your relay is too old to hold images. Update it: run wrangler deploy again from the new release, or restart the Node relay from it.',
  'syncSettings.urlFailed': 'The relay address could not be saved.',
  'syncSettings.vaultFailed': 'The vault could not be created.',
  'syncSettings.changeFailed': 'Sync could not be turned on or off.',
  'syncSettings.recovery': 'Recovery Key',
  'syncSettings.recoveryHint':
    'Keep this key in your password manager, or print it. With it and the relay’s address, a new device joins your vault even when no other device is left. Once you say you saved it, Devot does not show it again.',
  'syncSettings.recoveryCopy': 'Copy',
  'syncSettings.recoveryCopied':
    'The recovery key was copied. It leaves the clipboard after 90 seconds.',
  'syncSettings.recoverySaved': 'I Saved It',
  'syncSettings.copyFailed': 'The recovery key could not be copied.',
  'syncSettings.recoverySaveFailed': 'Devot could not note that the key was saved.',
  'syncSettings.setup': 'Set Up Sync',
  'syncSettings.setupHint':
    'Is this the first device you are syncing, or are you adding it to notes that another of your devices already syncs?',
  'syncSettings.setupFirst': 'This Is My First Device',
  'syncSettings.setupAnother': 'I’m Adding Another Device',
  'syncSettings.setupChange': 'Change Answer',
  'syncSettings.firstHint':
    'Devot makes your vault on a relay, a small server you run yourself, and gives you a recovery key to keep. Enter the relay’s address, then its secret.',
  'syncSettings.anotherHint':
    'On a device that already syncs, open Settings > Sync and choose Show Pairing Code. Scan the QR code here, or type or paste the code or the link. Joining adds this device to that vault and never makes a second one.',
  'syncSettings.usage.title': 'Storage',
  'syncSettings.usage.records': 'Notes and Other Records',
  'syncSettings.usage.images': 'Images',
  'syncSettings.usage.total': 'Total',
  'syncSettings.usage.room': 'Room Left',
  'syncSettings.usage.of': '{used} of {limit}',
  'syncSettings.usage.retry': 'Check Again',
  'syncSettings.usage.reading': 'Reading what the relay holds…',
  'syncSettings.usage.offline':
    'The relay cannot be reached, so its storage is not shown. It appears here when the relay can be reached again.',
  'syncSettings.usage.old':
    'Your relay is from an earlier release and cannot report its storage. Update it to see how much room is left.',
  'syncSettings.usage.failed': 'The relay’s storage could not be read.',
  'syncSettings.usage.roomImages': '{room}. Images can use {images} of that.',
  'syncSettings.usage.roomImagesUsed':
    '{room}. Images have used their share, so only notes can use it.',
  'syncSettings.usage.roomNone':
    'None left. New and changed notes and images wait until you free some.',
  'syncSettings.usage.noCap':
    'No limit. This relay runs without a storage cap, so only its own disk limits it.',
  'syncSettings.usage.unknownCap': 'Not known. This relay does not say what it may hold.',
  'syncSettings.usage.capNote':
    'This relay stores up to {limit} in all, and up to {images} of that for images, so notes always keep room.',
  'syncSettings.usage.capNoteTotal': 'This relay stores up to {limit} in all.',
  'syncSettings.pair': 'Add a Device',
  'syncSettings.pairHint':
    'Show a code here, then scan it with the new device’s camera, or copy the link and paste it there under Join With a Code. A bare code needs the relay’s address typed there too. It works once, for 10 minutes.',
  'syncSettings.pairShow': 'Show Pairing Code',
  'syncSettings.pairCopyLink': 'Copy Link',
  'syncSettings.pairLinkCopied':
    'The pairing link was copied. It carries the relay’s address, works once for 10 minutes, and leaves the clipboard after 90 seconds.',
  'syncSettings.pairCopyFailed': 'The pairing link could not be copied.',
  'syncSettings.pairQr': 'QR code for pairing a device',
  'syncSettings.pairCode': 'Pairing code',
  'syncSettings.pairExpiresIn': 'Expires in {time}.',
  'syncSettings.pairWaiting': 'Waiting for the other device…',
  'syncSettings.pairTaken': 'A device is joining…',
  'syncSettings.pairDone': 'A new device joined the vault.',
  'syncSettings.pairExpired': 'The code expired. Show a new one to try again.',
  'syncSettings.pairRetrying': 'Cannot reach the relay. Trying again…',
  'syncSettings.pairUnconfirmed':
    'A device took this code but did not finish joining. If that was not one of your devices, someone else may hold this vault’s key and could join later: check Devices and remove any you do not know.',
  'syncSettings.pairFailed': 'The pairing code could not be shown.',
  'syncSettings.pairCheckFailed': 'The pairing stopped.',
  'syncSettings.joinCode': 'Join With a Code',
  'syncSettings.joinCodeHint':
    'The code another of your devices shows under Add a Device, or the link its QR code holds. The link carries the relay’s address; with only the code, enter the relay below first.',
  'syncSettings.joinRecovery': 'Join With Recovery Key',
  'syncSettings.joinRecoveryHint':
    'The recovery key you saved when you turned sync on, with the relay above.',
  'syncSettings.join': 'Join',
  'syncSettings.linkRelayConfirm': 'Sync through the relay at {host}?',
  'syncSettings.linkRelayDetail':
    'The pasted link names this relay. Your notes will go through it, encrypted, so continue only if it is your own relay.',
  'syncSettings.linkRelayButton': 'Use This Relay',
  'syncSettings.joined': 'This device joined the vault and sync is on.',
  'syncSettings.joinFailed': 'This device could not join the vault.',
  'syncSettings.devices': 'Devices',
  'syncSettings.devicesHint':
    'The devices in this vault. Removing one stops it syncing; its notes stay on it.',
  'syncSettings.devicesList': 'Devices in this vault',
  'syncSettings.deviceAdded': 'Added {date}',
  'syncSettings.thisDevice': 'This Device',
  'syncSettings.deviceRemove': 'Remove…',
  'syncSettings.deviceRemoveLabel': 'Remove {name}, added {date}',
  'syncSettings.deviceRemoveConfirm': 'Remove {name}, added {date}, from sync?',
  'syncSettings.deviceRemoveDetail':
    'Sync stops there and its notes stay. The device still holds this vault’s key, so whoever has it can join again; Devot cannot change the key yet.',
  'syncSettings.deviceRemoveButton': 'Remove',
  'syncSettings.deviceRemoved': 'The device was removed from sync.',
  'syncSettings.devicesFailed': 'The devices could not be listed.',
  'syncSettings.devicesRetry': 'Try Again',
  'syncSettings.removeFailed': 'The device could not be removed.',
  'syncSettings.why.outdated':
    'Your relay is from before pairing: update it (docs/sync-relay.md, Update the relay). The recovery key works with it meanwhile.',
  'syncSettings.why.otherVault':
    'This device already holds another vault, which Devot never replaces.',
  'syncSettings.why.codeGone':
    'The code was used, canceled or has expired. Show a new one on the other device.',
  'syncSettings.why.codeMistyped': 'Check the code: it does not read as a pairing code.',
  'syncSettings.why.codeRefused':
    'What the relay handed over does not open with this code, so nothing was kept.',
  'syncSettings.why.otherRelay': 'The code is for another relay than the one set above.',
  'syncSettings.why.keyMistyped': 'Check the key: it does not read as a recovery key.',
  'syncSettings.why.noRelay': 'Enter the relay’s address above first.',
  'syncSettings.why.noVault': 'The relay set above has no such vault. Check its address.',
  'syncSettings.why.relayInvalid':
    'A relay’s address starts with https:// (http:// only for a relay on this computer).',
  'syncSettings.why.relaySecret':
    'The relay did not accept that secret. Check RELAY_SECRET on the relay.',
  'syncSettings.why.relaySecretInvalid':
    'The relay’s secret is empty or holds characters it cannot. Paste it again.',
  'syncSettings.why.unreachable':
    'The relay could not be reached, or it answered with an error. Check your connection and the relay’s address above.',
  'syncSettings.why.keychain':
    'The keychain did not let Devot keep this vault’s key. Allow access and try again.',
  'syncSettings.why.tooManyDevices':
    'The vault is at its device limit. Remove a device you no longer use from another device, then try again.',
  'syncSettings.why.enrollDenied':
    'The relay refused this device: the key or code belongs to another vault.',
  'syncSettings.icloudDetail':
    'Your notes sync through iCloud between the devices signed in to your Apple ID. Devot encrypts them before they leave this device, so Apple cannot read them.',
  'syncSettings.enabledHintIcloud':
    'Changes go to iCloud 3 seconds after you stop typing, and at least every 10 seconds while you type.',
  'syncSettings.transport': 'Syncs Through',
  'syncSettings.transportIcloud':
    'iCloud, with your notes encrypted by Devot before they leave this device.',
  'syncSettings.transportRelay': 'A relay you run yourself.',
  'syncSettings.transportQuestionHint':
    'With iCloud there is nothing to set up: the devices signed in to your Apple ID find your vault themselves. Devot encrypts your notes before they leave this device.',
  'syncSettings.useIcloud': 'Sync Through iCloud',
  'syncSettings.transportRelayAdvanced': 'Use My Own Relay',
  'syncSettings.useIcloudInstead': 'Use iCloud Instead',
  'syncSettings.icloudUnavailableBuild':
    'This build of Devot cannot sync through iCloud. Turn sync off here, or use a release build of Devot.',
  'syncSettings.icloudSignedOut':
    'Sign in to iCloud in System Settings to sync through it. Your notes stay on this device meanwhile.',
  'syncSettings.icloudRestricted':
    'iCloud is restricted on this device, by Screen Time or by whoever manages it, so Devot cannot sync through it. Your notes stay on this device.',
  'syncSettings.icloudTemporarilyUnavailable':
    'iCloud is not available right now. Devot tries again by itself, and your notes stay on this device meanwhile.',
  'syncSettings.icloudFull':
    'Your iCloud storage is full, so changes from this device are not syncing. Free up iCloud storage or get more in System Settings > Apple Account > iCloud; sync goes on by itself after that.',
  'syncSettings.icloudPausedUntil': 'Sync paused until {time}: iCloud asked Devot to wait.',
  'syncSettings.resumingICloud': 'iCloud takes changes again; sync resumes in a moment.',
  'syncSettings.icloudAccountChanged':
    'This device is now signed in to another Apple ID than the one this vault syncs through. Move the vault into this Apple ID, or turn sync off.',
  'syncSettings.icloudMoveToThisAccount': 'Move to This Apple ID',
  'syncSettings.icloudMoveConfirm': 'Move this vault into the Apple ID signed in now?',
  'syncSettings.icloudMoveDetail':
    'This device uploads all its notes there. Devices on the other Apple ID stop syncing with this one until they follow, by signing in to this Apple ID and moving there too.',
  'syncSettings.icloudMoveButton': 'Move',
  'syncSettings.icloudDeleted':
    'This vault’s data was removed from iCloud, perhaps under iCloud storage. Upload it again from this device, or turn sync off.',
  'syncSettings.icloudUploadAgain': 'Upload Again',
  'syncSettings.icloudUploadConfirm': 'Upload this vault to iCloud again?',
  'syncSettings.icloudUploadDetail':
    'This device uploads all its notes. Your other devices take part again when they next sync.',
  'syncSettings.icloudUploadButton': 'Upload',
  'syncSettings.turnOff': 'Turn Sync Off',
  'syncSettings.icloudJoined':
    'This device found your vault through the iCloud Keychain and joined it. Sync is on.',
  'syncSettings.icloudJoinAsk':
    'Your Apple ID already syncs a Devot vault. Join it? The {count} notes here go into it and reach your other devices.',
  'syncSettings.icloudJoin': 'Join',
  'syncSettings.icloudDecline': 'Not Now',
  'syncSettings.icloudDeclined':
    'Your Apple ID syncs a Devot vault, which you chose not to join yet. Join it whenever you like.',
  'syncSettings.icloudKeychainMissing':
    'Your Apple ID syncs a Devot vault, but its key has not reached this device through the iCloud Keychain. Join with a pairing code from one of your devices, or with the recovery key.',
  'syncSettings.icloudOtherItem':
    'The iCloud Keychain holds the key of another vault than the one your Apple ID syncs. Join with a pairing code from one of your devices, or with the recovery key.',
  'syncSettings.icloudOtherAccount':
    'The code comes from a device signed in to another Apple ID. Show a code on a device signed in to this one, or sign in to that Apple ID here.',
  'syncSettings.icloudStorage': 'Stored in iCloud',
  'syncSettings.icloudStorageValue':
    'About {size}, added up from the notes and images this vault syncs.',
  'syncSettings.icloudStorageReading': 'Adding up what the vault stores…',
  'syncSettings.icloudStorageFailed': 'What the vault stores could not be added up.',
  'syncSettings.icloudStorageManaged':
    'Your iCloud storage, and how much of it is left, is managed in System Settings > Apple Account > iCloud.',
  'syncSettings.icloudDevicesHint':
    'The devices syncing this vault through your Apple ID, with the day each was last seen. A device that signed out stays listed.',
  'syncSettings.deviceSeen': 'Seen {date}',
  'syncSettings.icloudDevicesUnseenHint':
    'The devices syncing this vault through your Apple ID, with the day each was last seen. A device not on iCloud yet still has to follow the move: open Settings > Sync on it.',
  'syncSettings.deviceUnseen': 'Added {date} · Not on iCloud yet',
  'syncSettings.vaultMoved': 'This vault moved to iCloud on another of your devices.',
  'syncSettings.vaultMovedHint': 'Follow it to keep syncing here.',
  'syncSettings.vaultMovedElsewhere': 'Set up sync again to follow it.',
  'syncSettings.vaultMovedFollow': 'Follow to iCloud',
  'syncSettings.vaultMovedHere':
    'The move of this vault to iCloud started on this device and did not finish.',
  'syncSettings.vaultMovedHereHint': 'Finish it to keep syncing here.',
  'syncSettings.vaultMovedFinish': 'Finish Moving to iCloud',
  'syncSettings.switchTransport': 'Move to iCloud',
  'syncSettings.switchTransportHint': 'Sync this vault through iCloud instead of the relay.',
  'syncSettings.switchTransportConfirm': 'Move this vault from the relay to iCloud?',
  'syncSettings.switchTransportDetail':
    'This device uploads all its notes to iCloud and leaves word on the relay. Your other devices follow when they next sync.',
  'syncSettings.switchTransportButton': 'Move',
  'syncSettings.rotate': 'Change Vault Key',
  'syncSettings.rotateHint':
    'Locks out a lost or removed device that still has the key. Your notes move to a new vault, and your other devices join it again with a pairing code or the new recovery key.',
  'syncSettings.rotateSecretHint':
    'Enter the relay\u2019s secret to make the new vault. It is used once and not kept.',
  'syncSettings.rotateButton': 'Change Key',
  'syncSettings.rotateFailed': 'The vault key could not be changed.',
  'syncSettings.rotated':
    'The vault key was changed. Save the new recovery key, then join your other devices again.',
  'syncSettings.rotatedAway':
    'The vault key was changed on another device. To sync again, enter a pairing code from a device that has the new key, or the new recovery key. Your notes stay here.',
  'syncSettings.why.rotated':
    'This key was changed. Use a pairing code from a device that has the new key, or the new recovery key.',
  'syncSettings.icloudChangeFailed': 'Sync through iCloud could not be changed.',
  'syncSettings.icloudLeave': 'Leave This Vault',
  'syncSettings.icloudLeaveHint':
    'Removes the vault from this Apple ID. Your notes stay on every device, and the other devices ask before they sync again. To pause sync and keep the vault, turn sync off.',
  'syncSettings.icloudLeaveKey': 'Recovery Key',
  'syncSettings.icloudLeaveKeyHint':
    'Type this vault’s recovery key to leave it. Nothing is removed from iCloud until you do.',
  'syncSettings.icloudLeaveButton': 'Leave This Vault',
  'syncSettings.icloudLeft': 'The vault was removed from iCloud. Your notes stay here.',
  'syncSettings.icloudLeaveFailed': 'The vault could not be left.',
  'syncSettings.pairHintIcloud':
    'Only for a device that did not join by itself through the iCloud Keychain. Show a code here and scan it on the new device. It works once, for 10 minutes.',
  'syncSettings.joinCodeIcloudHint':
    'The code one of your devices on this Apple ID shows under Add a Device, or the link its QR code holds.',
  'syncSettings.joinRecoveryIcloudHint':
    'The recovery key you saved when you first turned sync on.',
  'syncSettings.recoveryHintIcloud':
    'Keep this key in your password manager, or print it. With it, a device on your Apple ID joins your vault even when no other device is left. Once you say you saved it, Devot does not show it again.',
  'syncSettings.why.icloudBusy': 'iCloud is busy. Try again in a few minutes.',
  'syncSettings.why.icloudOtherVault':
    'Your Apple ID already syncs another vault, which Devot never replaces. Join it with a pairing code from one of its devices instead.',
  'syncSettings.why.icloudNoVault':
    'Your Apple ID does not sync the vault of that key. Check that this device is signed in to the Apple ID that syncs it.',
  'syncSettings.why.icloudNotUsed': 'This vault does not sync through iCloud.',
  'syncSettings.why.leaveOtherKey':
    'That is the recovery key of another vault. Type the key of the vault this device syncs.',
  'syncSettings.why.icloudFailed': 'iCloud answered with an error. Try again later.',
  'syncSettings.why.icloudZoneMissing':
    'The vault’s data is not in iCloud yet. Try again in a moment.',
  'syncSettings.why.icloudRecordInvalid':
    'iCloud holds something this release of Devot cannot read. Update Devot.',
  'syncSettings.why.icloudStaging':
    'Devot could not keep an image on this device for iCloud. Check that the disk has room.',
  'syncSettings.why.movedRefused':
    'The relay did not take the word that tells your other devices the vault moved, so it still syncs through the relay. Try again once the relay has room.',
  'sync.notice.revoked':
    'This device was removed from sync, so sync has stopped. Your notes stay on this device.',
  'sync.notice.clock':
    'Sync is paused: this device’s clock is more than 5 minutes off. Set the date and time automatically to sync again.',
  'sync.notice.stopped':
    'Sync has stopped. In Settings > Sync, turn Sync This Device off and on to try again, or set this device up again.',
  'sync.notice.stoppedAdvice': 'Sync has stopped. {advice}',
  'sync.advice.protocol': 'Update Devot and your relay to the same release.',
  'sync.advice.restoreChoice':
    'A backup was restored here: choose in the main window whether to merge or keep this Mac\u2019s copy.',
  'sync.advice.moved':
    'This vault now syncs another way. Set up sync again in Settings > Sync to follow it.',
  'sync.advice.rotated':
    'The vault key was changed on another device. Join again in Settings > Sync with a pairing code or the new recovery key.',
  'sync.advice.circuit':
    'A note kept changing back and forth between devices. Turn Sync This Device off and on in Settings > Sync to try again.',
  'sync.notice.storageFull':
    'Sync paused until {time}: the relay’s storage is full, so new and changed notes and images are not syncing. Notes from other devices still arrive, and everything works on this device. To sync again, remove images or notes you no longer need, or use a larger server.',
  'sync.notice.storageFullRetry':
    'Sync is trying again: the relay’s storage was full. If it pauses again, remove images or notes you no longer need, or use a larger server.',
  'sync.notice.usage.storageWarn':
    'The relay’s storage is more than 80% full. Sync keeps working. To keep room, remove images or notes you no longer need, or use a larger server. Settings > Sync shows what takes the room.',
  'sync.notice.usage.storageFull':
    'The relay’s storage is full, so new and changed notes and images are not syncing. Notes from other devices still arrive, and everything works on this device. To sync again, remove images or notes you no longer need, or use a larger server.',
  'sync.notice.usage.imagesWarn':
    'The relay’s room for images is more than 80% full. Notes keep syncing. To keep room, remove images you no longer need, or use a larger server.',
  'sync.notice.usage.imagesFull':
    'The relay has no room left for images, so new images are not syncing and stay on this device. Notes keep syncing. To sync them, remove images you no longer need, or use a larger server.',
  'sync.notice.licence':
    'Sync has stopped: it needs a Devot license. Your notes stay on this device. Add a license in Settings > License.',
  'sync.notice.licenceTrialEnded':
    'Sync has stopped: your trial has ended, and sync needs a Devot license. Your notes stay on this device. Add a license in Settings > License.',
  'sync.notice.licenceUnreadable':
    'Sync has stopped: Devot could not read its license from the keychain. Your notes stay on this device. See Settings > License.',
  'sync.notice.paused':
    'Sync paused until {time}: the relay has reached its quota for today. Your notes keep working on this device and sync after that.',
  'sync.notice.pausedUpload':
    'Sync paused until {time}: the relay has reached its quota for today, with {sent} of {total} items uploaded. The upload goes on after that; your notes keep working on this device.',
  'sync.notice.resuming':
    'The relay’s quota for today has reset; sync resumes in a moment. Your notes keep working on this device.',
  'sync.notice.resumingUpload':
    'The relay’s quota for today has reset; sync resumes in a moment, with {sent} of {total} items uploaded so far.',
  'sync.notice.tooLargeOne': '{count} note is too large to sync and stays on this device only.',
  'sync.notice.tooLargeOther': '{count} notes are too large to sync and stay on this device only.',
  'sync.notice.icloudSignedOut':
    'Sync is paused: this device is not signed in to iCloud. Sign in to iCloud in System Settings to sync again; your notes stay on this device.',
  'sync.notice.icloudRestricted':
    'Sync is paused: iCloud is restricted on this device, by Screen Time or by whoever manages it. Your notes stay on this device.',
  'sync.notice.icloudTemporarilyUnavailable':
    'iCloud is not available right now. Sync tries again by itself; your notes keep working on this device.',
  'sync.notice.icloudFull':
    'Sync is paused: your iCloud storage is full, so changes from this device are not syncing. Free up iCloud storage or get more in System Settings > Apple Account > iCloud; sync goes on by itself after that.',
  'sync.notice.icloudPausedUntil':
    'Sync paused until {time}: iCloud asked Devot to wait. Your notes keep working on this device.',
  'sync.notice.icloudAccountChanged':
    'Sync has stopped: this device is signed in to another Apple ID than the one your vault syncs through on iCloud. In Settings > Sync, move the vault into this Apple ID or turn sync off.',
  'sync.notice.icloudDeleted':
    'Sync has stopped: your vault’s data was removed from iCloud. In Settings > Sync, upload it again from this device or turn sync off.',
  'sync.notice.icloudUnavailableBuild':
    'Sync has stopped: this build of Devot cannot sync through iCloud. Turn sync off in Settings > Sync, or use a release build of Devot.',
  'sync.notice.vaultMoved':
    'Sync has stopped: your vault moved to iCloud on another of your devices. Follow it in Settings > Sync.',
  'sync.notice.vaultMovedHere':
    'Sync has stopped: the move of your vault to iCloud started on this device and did not finish. Finish it in Settings > Sync.',
  'sync.notice.icloudJoined':
    'This device found your vault through the iCloud Keychain and joined it. Sync is on.',
  'sync.notice.icloudJoinAsk':
    'Your Apple ID syncs a Devot vault. To join it with the {count} notes here, open Settings > Sync.',
  'sync.notice.icloudKeychainMissing':
    'Your Apple ID syncs a Devot vault, but its key has not reached this device. Join with a pairing code or the recovery key in Settings > Sync.',
  'sync.notice.icloudOtherItem':
    'The iCloud Keychain holds the key of another vault than the one your Apple ID syncs. Join with a pairing code or the recovery key in Settings > Sync.',
  'sync.restore.message': 'Sync the notes restored from a backup?',
  'sync.restore.detail':
    'Merge brings back the changes your other devices made since the backup. Keep This Mac\u2019s Copy makes the restored notes replace them on every device. Notes deleted for good on another device can\u2019t come back either way.',
  'sync.restore.merge': 'Merge',
  'sync.restore.keep': 'Keep This Mac\u2019s Copy',
} as const
