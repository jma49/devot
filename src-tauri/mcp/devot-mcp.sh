#!/bin/sh
# Runs the MCP bridge of the Devot installed on this Mac. It holds no server and no token, so an
# extension or plugin that carries it stays small and follows the app's updates. stdout is MCP's.
for app in "$1" /Applications/Devot.app "$HOME/Applications/Devot.app"; do
  if [ -n "$app" ] && [ -x "$app/Contents/MacOS/devot" ]; then
    exec "$app/Contents/MacOS/devot" --cli mcp
  fi
done
found=$(/usr/bin/mdfind 'kMDItemCFBundleIdentifier == "io.github.jma49.devot"' 2>/dev/null | /usr/bin/head -n 1)
if [ -n "$found" ] && [ -x "$found/Contents/MacOS/devot" ]; then
  exec "$found/Contents/MacOS/devot" --cli mcp
fi
echo "E_MCP_APP_NOT_FOUND" >&2
exit 1
