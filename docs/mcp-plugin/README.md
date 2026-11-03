# Devot's directory plugin (not published)

The layout a plugin for Claude's directory would take, kept here until the owner decides to submit it. Nothing here is published, and no public repository exists for it.

- `.claude-plugin/plugin.json`: the plugin's manifest.
- `.mcp.json`: one MCP server, `devot`, run by `/bin/sh` from the plugin's own folder.
- `bin/devot-mcp.sh`: the launcher, byte for byte the one Settings puts in its `.mcpb` (`src-tauri/mcp/devot-mcp.sh`; `tests/core/mcp-tools.test.ts` holds them alike). It looks in `/Applications`, then `~/Applications`, then asks Spotlight for the bundle identifier, and runs `devot --cli mcp` from what it finds. It holds no server, no token and no notes, so the plugin stays a few KB and follows the app's updates.

With no Devot on the Mac it exits with `E_MCP_APP_NOT_FOUND` on stderr, so a client shows a failed server rather than a tool. Everything else is as for any client: AI tools stay off until the owner allows them in Settings > Integrations, and notebooks until the owner allows each one (ADR 0012).

## Still undetermined

- Whether the directory takes a plugin that needs an app installed first, and how a listing says so.
- What it needs at submission: a public source repository, a privacy policy URL, a licence the directory accepts for a launcher, reviewed tool annotations.
- Whether a plugin may turn on Allow AI Tools by itself. It cannot today: a first call answers `E_MCP_ACCESS_OFF` until the owner turns it on in Settings, and the hint says where.
- The plugin's version scheme, and whether it should follow the app's.
- Whether `mdfind` is allowed by a client's sandbox on every client that would run it. `/Applications` is tried first, so only a Devot kept elsewhere depends on it.
