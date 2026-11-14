export const prefixes = [
  'mirror',
  'import',
  'export',
  'pageSetup',
  'backups',
  'searchIndex',
  'templates',
]

export const messages = {
  'pageSetup.title': 'Page Setup',
  'pageSetup.paper': 'Paper',
  'pageSetup.paper.a4': 'A4',
  'pageSetup.paper.letter': 'US Letter',
  'pageSetup.paper.a4Landscape': 'A4 Landscape',
  'pageSetup.paper.slide': 'Slide (16:9)',
  'pageSetup.margins': 'Margins',
  'pageSetup.margins.narrow': 'Narrow',
  'pageSetup.margins.normal': 'Normal',
  'pageSetup.margins.wide': 'Wide',
  'pageSetup.header': 'Header',
  'pageSetup.footer': 'Footer',
  'pageSetup.left': 'Left',
  'pageSetup.center': 'Center',
  'pageSetup.right': 'Right',
  'pageSetup.fields':
    'In the header and footer, {title} is the note\u2019s title, {page} the page number, {total} the number of pages and {date} today\u2019s date.',
  'pageSetup.skipFirst': 'Leave them off the first page',
  'pageSetup.rules': 'Thin rules under the header and above the footer',
  'pageSetup.print': 'Print\u2026',
  'pageSetup.export': 'Export\u2026',
  'templates.new': 'New Template',
  'templates.pickTitle': 'New Note from Template',
  'templates.filter': 'Filter templates',
  'templates.recent': 'Recently Used',
  'templates.builtIn': 'Built-in',
  'templates.builtInHint': 'Built-in templates are read-only. Edit a copy to make one of your own.',
  'templates.starter.brainstorming.title': 'Brainstorming',
  'templates.starter.brainstorming.body': `> # !Instructions
> Write the topic under Goal, then list every idea without judging it.
> Group the ideas, pick the best few and give each a next step.

# {{title}}

## Goal

## Ideas

- 

## Groups

## Next steps

- [ ] 
`,
  'templates.starter.debugging.title': 'Debugging',
  'templates.starter.debugging.body': `> # !Instructions
> Describe what you expected and what happened, then record each attempt
> and what it showed. Finish with the cause and the fix.

# {{title}}

## Expected behavior

## Actual behavior

## Steps to reproduce

1. 

## Attempts

- 

## Cause

## Fix

- [ ] 
`,
  'templates.starter.learning.title': 'Learning',
  'templates.starter.learning.body': `> # !Instructions
> Note the source and what you want to learn. Write the key points in your
> own words, then questions, then a short summary you could teach from.

# {{title}}

## Source

## What I want to learn

## Key points

- 

## Questions

- 

## Summary
`,
  'templates.starter.planning.title': 'Planning',
  'templates.starter.planning.body': `> # !Instructions
> State the outcome and why it matters. Break it into tasks with owners and
> dates, and list what could go wrong.

# {{title}}

## Outcome

## Why it matters

## Tasks

- [ ] 

## Timeline

## Risks
`,
  'templates.starter.daily-report.title': 'Daily Report',
  'templates.starter.daily-report.body': `---
title: Daily Report {{date}}
---

> # !Instructions
> Fill this in at the end of the day. {{date}} is replaced with today's date
> in each note made from this template.

# {{title}}

## Done today

- 

## In progress

- 

## Blockers

- 

## Plan for tomorrow

- [ ] 
`,
  'templates.editCopy': 'Edit a Copy',
  'templates.noMatches': 'No templates match.',
  'templates.create': 'Create',
  'templates.chooseTitle': 'Choose a Template',
  'templates.use': 'Use Template',
  'templates.preview': 'Preview',
  'templates.notebook': 'Notebook: {name}',
  'templates.tags': 'Tags: {tags}',
  'templates.status': 'Status: {status}',
  'templates.editorHint':
    'Template. Front matter sets the title, notebook, tags and status of notes made from it; {{date}}, {{time}}, {{title}} and {{uuid}} are filled in. A quote that starts with a ! heading is left out of those notes.',
  'mirror.title': 'Markdown Mirror',
  'mirror.detail':
    'Devot keeps a folder up to date with every note as a Markdown file, laid out like an export, so other apps and tools can read your notes.',
  'mirror.notReadBack':
    'The folder is written by Devot: edits made there are not read back. A file changed there is kept under a new name, and Devot writes its own version.',
  'mirror.off': 'The mirror is off.',
  'mirror.folderLabel': 'Folder',
  'mirror.chooseFolder': 'Choose Folder\u2026',
  'mirror.turnOff': 'Turn Off',
  'mirror.includeAttachments': 'Include Attachments',
  'mirror.includeAttachmentsHint':
    'Off, images still link to the attachments folder, but no copies are written there.',
  'mirror.size': 'Size on disk: {size}',
  'mirror.paused': 'The mirror is paused. It resumes once its folder can be written again.',
  'mirror.pausedMissing':
    'The mirror is paused: its folder is missing. It resumes once the folder is back.',
  'mirror.pausedReadOnly':
    'The mirror is paused: its folder cannot be written. It resumes once it can.',
  'mirror.pausedManifestMissing':
    'The mirror is paused: the list of files Devot wrote in its folder (.devot-mirror.json) is missing. Put it back, or choose the folder again to go on.',
  'mirror.pausedManifestInvalid':
    'The mirror is paused: the list of files Devot wrote in its folder (.devot-mirror.json) cannot be read. Choose the folder again to go on.',
  'mirror.pausedManifestForeign':
    'The mirror is paused: its folder holds the files of another Devot library. Choose the folder again to go on.',
  'mirror.chooseFailed': 'The folder could not be used.',
  'mirror.changeFailed': 'The mirror setting could not be saved.',
  'mirror.confirm': 'Use \u201c{name}\u201d for the Markdown mirror?',
  'mirror.confirmDetail':
    'The folder is not empty. Devot adds its files beside the ones there and never changes or deletes a file it did not write; a file that already holds exactly what Devot would write is taken as Devot\u2019s.',
  'mirror.confirmUse': 'Use Folder',
  'mirror.keptOne': 'A file edited outside Devot was kept under a new name: {files}.',
  'mirror.keptOther': '{count} files edited outside Devot were kept under new names: {files}.',
  'mirror.keptMore': '{count} more',
  'backups.title': 'Backups',
  'backups.detail': 'Devot backs up your notes every day and keeps the last 7 backups.',
  'backups.empty': 'No backups yet.',
  'backups.now': 'Back Up Now',
  'backups.done': 'Done',
  'backups.restore': 'Restore\u2026',
  'backups.restoreLabel': 'Restore the backup from {date}',
  'backups.unverified': 'Unverified copy',
  'backups.confirmRestore': 'Restore the backup from {date}?',
  'backups.confirmRestoreDetail':
    'Your current notes will be replaced. Devot backs them up first, so you can go back to them.',
  'backups.confirm': 'Restore',
  'backups.failed': 'The backup failed.',
  'backups.listFailed': 'The backups could not be listed.',
  'backups.restoreFailed': 'The backup could not be restored.',
  'backups.restoreWindows':
    'The backup was not restored: another Devot window did not get ready in time. Try again.',
  'backups.restoreSyncOn':
    'A backup can\u2019t be restored while sync is on: the next sync would bring back the changes made since.',
  'backups.autoFailed': 'The automatic backup failed.',
  'backups.show': 'Show Backups',
  'searchIndex.rebuilding': 'Rebuilding search index\u2026',
  'searchIndex.rebuiltOne': 'Search index rebuilt ({count} note).',
  'searchIndex.rebuiltOther': 'Search index rebuilt ({count} notes).',
  'searchIndex.failed': 'The search index could not be rebuilt.',
  'export.failed': 'The export did not complete.',
  'export.partial': 'The export is incomplete: {written} written, {problems} with problems.',
  'export.allName': 'Devot Notes',
  'export.selectionName': 'Devot Export',
  'export.printFailed': 'The note could not be printed.',
  'export.copyFailed': 'The note could not be copied.',
  'export.copyLinkFailed': 'The note link could not be copied.',
  'export.copyLinksFailed': 'The note links could not be copied.',
  'export.copyIdFailed': 'The ID could not be copied.',
  'import.title': 'Import Markdown Folder',
  'import.title.folders': 'Import Markdown Folders',
  'import.title.markdown': 'Import Markdown Files',
  'import.title.html': 'Import HTML Files',
  'import.scanning': 'Looking through \u201c{name}\u201d\u2026',
  'import.scanLabel': 'Scan progress',
  'import.scanFound': '{files} and {images} found so far',
  'import.found': 'Found {files} and {images} ({size}).',
  'import.mapping.folder':
    'Files at the top go into the notebook you choose next; each folder with notes becomes a notebook inside it.',
  'import.mapping.folders':
    'Each folder becomes a notebook inside the notebook you choose next, with its own folders nested in it.',
  'import.treeLabel': 'Folders found',
  'import.folderCounts': '{files} \u00b7 {images} \u00b7 {size}',
  'import.notebookBadge': 'Notebook',
  'import.treeSummary': '{books} \u00b7 {notes}',
  'import.willSkip': 'Will be skipped',
  'import.markdownOne': '{count} Markdown file',
  'import.markdownOther': '{count} Markdown files',
  'import.imageCountOne': '{count} image',
  'import.imageCountOther': '{count} images',
  'import.continue': 'Continue',
  'import.back': 'Back',
  'import.import': 'Import',
  'import.importInto': 'Import into \u201c{name}\u201d',
  'import.destination': 'Import into',
  'import.destinationDetail': 'Choose a notebook for {notes}.',
  'import.destinationFilter': 'Filter notebooks',
  'import.counts': '{imported} imported \u00b7 {skipped} skipped \u00b7 {failed} failed',
  'import.reason.fileType': 'Not a file of the kind picked',
  'import.reason.cancelled': 'The scan was canceled.',
  'import.running': 'Importing \u201c{name}\u201d\u2026',
  'import.progress': '{done} of {files}',
  'import.progressLabel': 'Import progress',
  'import.summary': 'Imported {notes} into {books}.',
  'import.summaryWithImages': 'Imported {notes} into {books}. {images}',
  'import.summaryNoBooks': 'Imported {notes}.',
  'import.summaryNoBooksWithImages': 'Imported {notes}. {images}',
  'import.imagesOne': '{count} image was added as an attachment.',
  'import.imagesOther': '{count} images were added as attachments.',
  'import.wikiLinks': 'Convert [[wiki links]] to note links and images',
  'import.unresolvedLinksOne': '{count} wiki link matched no note or image and was kept as text.',
  'import.unresolvedLinksOther':
    '{count} wiki links matched no note or image and were kept as text.',
  'import.empty': 'No Markdown files were found in \u201c{name}\u201d.',
  'import.problems': 'Not imported',
  'import.failed': 'The import failed.',
  'import.done': 'Done',
  'import.filesOne': '{count} file',
  'import.filesOther': '{count} files',
  'import.booksOne': '{count} notebook',
  'import.booksOther': '{count} notebooks',
  'import.reason.tooLarge': 'Larger than 10 MB',
  'import.reason.size': 'Empty or larger than 10 MB',
  'import.reason.notUtf8': 'Not UTF-8 text',
  'import.reason.notFound': 'File not found',
  'import.reason.outside': 'Outside the imported folder',
  'import.reason.tag': 'Tag not added: not a valid tag name',
  'import.reason.type': 'Not a supported image format',
  'import.reason.path': 'Hidden or not a valid path',
  'import.reason.unreadable': 'Could not be read',
  'import.reason.tooDeep': 'Inside too many nested folders',
  'import.reason.name': 'The name is not valid text',
  'import.reason.linkHidden': 'A link to a hidden file or folder',
  'import.reason.unlocated': 'Its link could not be changed to the imported image',
  'import.reason.htmlDropped': 'Left out: HTML content a note cannot hold',
  'import.reason.incomplete': 'Imported in part; check this note',
  'import.reason.session': 'The import ended before this file was read',
  'import.reason.stopped': 'The import stopped before this file',
  'import.reason.other': 'Could not be imported',
  'import.reason.tooManyFiles': 'The folder has more than 10,000 Markdown files.',
  'import.reason.folderTooLarge': 'The folder holds too many files to import.',
  'import.reason.folderInvalid': 'This folder cannot be read.',
  'import.reason.foldersUnsupported': 'Folders cannot be imported on this device.',
  'import.reason.trialEnded':
    'Your Devot trial has ended, so nothing can be imported. Add a license in Settings > License.',
  'import.reason.licenceUnreadable':
    'Devot could not read its license from the keychain, so nothing can be imported now. See Settings > License.',
} as const
