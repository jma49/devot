export const prefixes = ['licenceSettings', 'licence', 'trial', 'updates']

export const messages = {
  'licenceSettings.title': 'License',
  'licenceSettings.detail':
    'Devot works fully for a 30-day trial. After it, notes can still be read, searched, copied and exported, but editing them, sync and AI need a Devot license. A license is bought once, checked on this device without going online, and unlocks everything in every version of Devot, with nothing to renew.',
  'licenceSettings.ungated':
    'This build of Devot does not check licenses, so everything works without one.',
  'licenceSettings.status': 'Status',
  'licenceSettings.state.none': 'No license is added.',
  'licenceSettings.state.valid': 'Editing, sync and AI are unlocked on this device.',
  'licenceSettings.state.revoked': 'This license was revoked after a refund or a lost dispute.',
  'licenceSettings.state.invalid':
    'The license on this device could not be verified. Add the key from your purchase email again.',
  'licenceSettings.state.unreadable': 'The license could not be read. {problem}',
  'licenceSettings.state.purchased': 'Devot Pro, bought on the App Store.',
  'licenceSettings.state.storeReading': 'Checking your App Store purchases.',
  'licenceSettings.state.storeUnread': 'Your App Store purchases could not be checked: {problem}',
  'licenceSettings.trial': 'Trial',
  'licenceSettings.trial.running':
    'Everything works, sync and AI included, until the trial ends on {date} ({left} left).',
  'licenceSettings.trial.ended':
    'The trial has ended, so notes are read-only and sync and AI are locked until you add a license.',
  'licenceSettings.trial.unreadable':
    'The trial could not be read from the keychain, so notes are read-only until you add a license.',
  'licenceSettings.trial.available': 'Not started. Start it free from Buy Devot Pro.',
  'licenceSettings.licensee': 'Licensed To',
  'licenceSettings.id': 'License ID',
  'licenceSettings.devices': 'Devices',
  'licenceSettings.devices.seats': '{used} of {limit} devices are in use.',
  'licenceSettings.devices.required':
    'This device is not activated yet. Connect to the internet to activate it.',
  'licenceSettings.devices.expired':
    'This device’s activation has expired. Connect to the internet to renew it.',
  'licenceSettings.devices.manage': 'Manage Devices',
  'licenceSettings.devices.retry': 'Retry Activation',
  'licenceSettings.devices.refreshed': 'This device’s activation was renewed.',
  'licenceSettings.devices.refreshFailed': 'The activation could not be renewed. {problem}',
  'licence.reason.deviceLimit':
    'Every device this license allows is in use. Remove one at Manage Devices, then try again.',
  'licence.reason.activationRequired':
    'This device is not activated yet. Connect to the internet and try again.',
  'licence.reason.activationExpired':
    'This device’s activation has expired. Connect to the internet and try again.',
  'licence.reason.activationFailed':
    'The license service could not be reached. Try again in a moment.',
  'licence.reason.activationUnreadable':
    'This device’s activation record could not be read. Add the key again or choose Retry Activation.',
  'licence.reason.rateLimited': 'Too many attempts. Try again in a while.',
  'licenceSettings.key': 'License Key',
  'licenceSettings.keyHint': 'Paste the key from your purchase email. It starts with devot1.',
  'licenceSettings.replaceHint': 'Paste another key to replace the license on this device.',
  'licenceSettings.add': 'Add License',
  'licenceSettings.replace': 'Replace License',
  'licenceSettings.removeAsk': 'Remove License…',
  'licenceSettings.remove': 'Remove License',
  'licenceSettings.removeConfirm': 'Remove the license from this device?',
  'licenceSettings.removeDetail':
    'Once the trial is over, notes on this device are read-only and sync and AI stop until you add a license again. You can add the same key again at any time.',
  'licenceSettings.buy': 'Buy a License',
  'licenceSettings.buyPro': 'Buy Devot Pro',
  'licenceSettings.added': 'The license was added.',
  'licenceSettings.removed': 'The license was removed.',
  'licenceSettings.addFailed': 'The key could not be added. {problem}',
  'licenceSettings.removeFailed': 'The license could not be removed.',
  'licence.reason.malformed': 'This is not a complete Devot license key.',
  'licence.reason.unknownKid':
    'It was signed by a key this version of Devot does not know. Update Devot and try again.',
  'licence.reason.signature':
    'Its signature does not match, so it was changed after it was issued.',
  'licence.reason.keychain': 'The keychain could not be used.',
  'licence.reason.keychainDenied':
    'macOS did not let Devot read its keychain items. When macOS asks again, enter your login password and click Always Allow.',
  'licence.reason.other': 'Something went wrong.',
  'licence.reason.keysOff':
    'This version of Devot unlocks through the App Store, not with a license key.',
  'licence.reason.storeNoReply': 'The App Store did not reply.',
  'licence.reason.storeUnavailable': 'The App Store cannot be used on this device.',
  'licence.reason.storeUnverified': 'The App Store could not verify the purchase.',
  'licence.reason.storeUpstream': 'The App Store’s answer could not be checked. Try again later.',
  'licence.reason.noPro': 'This Apple Account holds no Devot Pro purchase.',
  'licence.reason.storeProduct': 'This purchase comes with no license key.',
  'licence.reason.familyShared':
    'A purchase shared through Family Sharing comes with no license key.',
  'licence.reason.revoked': 'This license has been revoked.',
  'licence.reason.exchangeFailed': 'The license server could not give a key. Try again later.',
  'licence.appStoreLicensee': 'Bought on the App Store',
  'licence.appStoreLicenseeInline': 'an App Store purchase',
  'licence.locked.sync': 'Sync needs a Devot license. Add one in Settings > License.',
  'licence.locked.ai': 'AI needs a Devot license. Add one in Settings > License.',
  'licence.locked.syncTrialEnded':
    'Your trial has ended, and sync needs a Devot license. Add one in Settings > License.',
  'licence.locked.aiTrialEnded':
    'Your trial has ended, and AI needs a Devot license. Add one in Settings > License.',
  'licence.locked.syncPro': 'Sync needs Devot Pro. Get it in Settings > License.',
  'licence.locked.aiPro': 'AI needs Devot Pro. Get it in Settings > License.',
  'licence.locked.syncProTrialEnded':
    'Your trial has ended, and sync needs Devot Pro. Get it in Settings > License.',
  'licence.locked.aiProTrialEnded':
    'Your trial has ended, and AI needs Devot Pro. Get it in Settings > License.',
  'trial.ended':
    'Your Devot trial has ended, so notes are read-only: you can read, search, copy and export them. Add a license to edit them again.',
  'trial.reminder.today':
    'Your Devot trial ends today at {time}. After that, notes are read-only until you add a license.',
  'trial.reminder.tomorrow':
    'Your Devot trial ends tomorrow at {time}. After that, notes are read-only until you add a license.',
  'licence.replace.message': 'Replace the license on this device?',
  'licence.replace.detail':
    'This device holds the license for {current} ({currentId}). The key in the link is for {licensee} ({id}).',
  'licence.replace.detailInvalid':
    'The license on this device could not be verified. The key in the link is for {licensee} ({id}).',
  'licence.replace.confirm': 'Replace',
  'updates.checking': 'Checking for updates\u2026',
  'updates.upToDate': 'Devot {version} is the latest version.',
  'updates.available': 'Devot {version} is available.',
  'updates.download': 'Download',
  'updates.downloading': 'Downloading Devot {version}\u2026',
  'updates.downloadingPercent': 'Downloading Devot {version} ({percent}%)\u2026',
  'updates.ready': 'Devot {version} is ready to install.',
  'updates.restart': 'Restart to Update',
  'updates.later': 'Later',
  'updates.failed': 'Devot could not check for or install updates.',
  'updates.unavailable': 'This build of Devot does not update itself.',
} as const
