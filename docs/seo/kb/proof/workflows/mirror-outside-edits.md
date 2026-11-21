---
id: wf-mirror-outside-edits
category: workflows
date: 2026-11-21
topics: [markdown-mirror, outside-edits]
verified: true
source: README.md
---

# Outside edits in the Markdown mirror

Settings, Mirror keeps a folder up to date with every note as a Markdown file.
A folder per notebook, a file per note, images in an `attachments` folder.
Templates and the Trash are left out.

Bring Back Outside Edits merges a file changed elsewhere into its note, so history and sync keep working.
Without that switch, or when the note also changed in Devot, Devot renames the outside file to `<name> (edited outside Devot).md`, tells the owner, and writes its own version.
Files Devot did not write are never changed.

If the folder goes missing, the mirror pauses and resumes by itself once it can.
If `.devot-mirror.json` goes missing or is damaged, the mirror pauses until the folder is chosen again.

## Reusable snippet

A Markdown file changed outside Devot is not overwritten: Devot either merges it back when Bring Back Outside Edits is on, or renames it to `<name> (edited outside Devot).md` and writes its own copy (`README.md`, Markdown mirror).
