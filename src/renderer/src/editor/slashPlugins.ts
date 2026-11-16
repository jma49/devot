// Plugin commands the slash menu lists (ADR 0023), set by the window's plugin host as the plugins change.

export interface SlashPluginCommand {
  plugin: string
  command: string
  title: string
  pluginName: string
}

let listed: readonly SlashPluginCommand[] = []
let runner: ((plugin: string, command: string) => void) | null = null

export function setSlashPlugins(
  commands: readonly SlashPluginCommand[],
  run: ((plugin: string, command: string) => void) | null,
) {
  listed = commands
  runner = run
}

export const slashPlugins = (): readonly SlashPluginCommand[] => listed

export function runSlashPlugin(plugin: string, command: string) {
  runner?.(plugin, command)
}
