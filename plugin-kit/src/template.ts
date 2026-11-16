// The files `devot-plugin new` writes: a plugin with one command that works on the selection, ready to install.
import { PLUGIN_API_VERSION } from '../../src/core/plugins/manifest'
import { MANIFEST_FILE } from './package'

export function templateFiles(id: string, name: string): Map<string, string> {
  const manifest = {
    id,
    name,
    version: '0.1.0',
    apiVersion: PLUGIN_API_VERSION,
    description: '',
    main: 'main.js',
    permissions: ['note.read', 'note.edit', 'commands'],
    contributes: {
      commands: [{ id: 'upper-case', title: 'Upper Case Selection' }],
      slashMenu: [{ command: 'upper-case' }],
    },
  }
  const main = `// @ts-check
/// <reference types="@devot/plugin-kit" />

devot.commands.handle('upper-case', async () => {
  const selection = await devot.note.selection()
  await devot.note.insert(selection.text.toUpperCase(), { replacing: selection.text })
})
`
  const pkg = {
    name: id.replaceAll('.', '-'),
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: { validate: 'devot-plugin validate', pack: 'devot-plugin pack' },
    devDependencies: { '@devot/plugin-kit': '^0.1.0' },
  }
  const readme = `# ${name}

Select some text in a note and run Upper Case Selection from the Command Palette or the slash menu.

- \`npm run validate\` checks the manifest by Devot's own rules.
- \`npm run pack\` writes the \`.zip\` to install in Settings, Plugins.
`
  return new Map([
    [MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`],
    ['main.js', main],
    ['package.json', `${JSON.stringify(pkg, null, 2)}\n`],
    ['README.md', readme],
  ])
}
