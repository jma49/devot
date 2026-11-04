#!/bin/sh
# Runs the MCP bridge of the Devot installed on this Mac. It holds no server and no token, so an
# extension or plugin that carries it stays small and follows the app's updates. stdout is MCP's.
# Only fixed places and the one given: a bundle found by its identifier elsewhere could be any copy.
for app in "$1" /Applications/Devot.app "$HOME/Applications/Devot.app"; do
  if [ -n "$app" ] && [ -x "$app/Contents/MacOS/devot" ]; then
    exec "$app/Contents/MacOS/devot" --cli mcp
  fi
done
echo "E_MCP_APP_NOT_FOUND Devot is not installed on this Mac. Install it from https://devot.online, then try again." >&2
exit 1
