This is your library. Everything you write stays on this Mac, in a database in the app's data folder (Application Support), and nothing is sent anywhere. Delete this notebook whenever you like: it will not come back.

## Organize

- **Notebooks** hold notes and can nest. Make one with the _New Notebook_ button in the sidebar, and drag notebooks and notes to move them.
- **Tags** go on any note from the command palette ({{key:palette.open}}). Click a tag in the sidebar to filter the list by it.
- **Status** marks where a note stands: None {{key:status.none}}, Active {{key:status.active}}, On Hold {{key:status.onHold}}, Completed {{key:status.completed}}, Dropped {{key:status.dropped}}.
- **Pin to Top** keeps a note at the top of its list ({{key:note.pin}} in the note list).
- **Templates** start a note from a note of your own: New Note from Template, {{key:note.newFromTemplate}}.
- Deleted notes wait in the **Trash** ({{key:note.trash}} in the note list) until you empty it.

## Write

Each note has three views, in the View menu: _Show Editor_, _Show Editor and Preview_ and _Preview_. The editor shows your Markdown with its syntax highlighted; the preview shows the result and scrolls along with the editor.

| Do this                       | Press                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------- |
| New note                      | {{key:note.new}}                                                                |
| Bold, italic, strikethrough   | {{key:format.bold}}, {{key:format.italic}}, {{key:format.strikethrough}}        |
| Inline code, code block       | {{key:format.code}}, {{key:format.codeBlock}}                                   |
| Link                          | {{key:format.link}}                                                             |
| Headings 1 to 6               | {{key:format.heading1}} to {{key:format.heading6}}                              |
| Bulleted, numbered, task list | {{key:format.bulletList}}, {{key:format.numberedList}}, {{key:format.taskList}} |
| Quote                         | {{key:format.quote}}                                                            |

Type `/` at the start of a line for a menu of everything you can insert, and `[[` to link to another note by its title. Paste or drop an image to attach it to the note. See the **Markdown example** note in this notebook for every kind of Markdown Devot understands.

## Find your way

- **Command palette** {{key:palette.open}}: every command, notes, notebooks and tags in one list.
- **Find in the note** {{key:find.find}}, and replace {{key:find.replace}}.
- **Search** the library {{key:search.view}}, or all notes {{key:search.all}}. Searching understands words, phrases and filters such as notebook and tag names.
- **Back and forward** between notes: {{key:note.back}} and {{key:note.forward}}. Next and previous note: {{key:note.next}} and {{key:note.previous}}.
- **Hide the sidebar** {{key:view.sidebar}}, **Focus Mode** {{key:view.focus}}, and the text size {{key:view.fontBigger}} bigger, {{key:view.fontSmaller}} smaller, {{key:view.fontReset}} back to normal.
- **History** {{key:note.history}} lists the versions of a note and shows what changed between them.

## Your data

- Devot backs up the library every day and keeps the last seven backups (_Backups_ in the command palette).
- The **Markdown Mirror** keeps a folder of plain `.md` files in step with your notes, if you choose one in the command palette.
- Any note exports as Markdown, HTML or PDF from its menu, and a Markdown folder can be imported.
- Notebooks are closed to AI tools until you switch _Allow AI Access_ on for a notebook.

Have a look at the [Markdown example](devot://note/{{id:example}}) next.
