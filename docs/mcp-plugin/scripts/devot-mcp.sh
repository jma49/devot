#!/bin/sh
# Runs the MCP bridge of the Devot installed on this Mac. It holds no server and no token, so an
# extension or plugin that carries it stays small and follows the app's updates. stdout is MCP's.
for app in "$1" /Applications/Devot.app "$HOME/Applications/Devot.app"; do
  if [ -n "$app" ] && [ -x "$app/Contents/MacOS/devot" ]; then
    exec "$app/Contents/MacOS/devot" --cli mcp
  fi
done
# Spotlight also lists builds without a Mac binary, such as an iOS one, so take the first that has it.
found=$(/usr/bin/mdfind 'kMDItemCFBundleIdentifier == "io.github.jma49.devot"' 2>/dev/null |
  while IFS= read -r app; do
    if [ -x "$app/Contents/MacOS/devot" ]; then
      printf '%s\n' "$app"
      break
    fi
  done)
if [ -n "$found" ]; then
  exec "$found/Contents/MacOS/devot" --cli mcp
fi
echo "E_MCP_APP_NOT_FOUND Devot is not installed on this Mac. Install it from https://devot.online, then try again." >&2
exit 1
