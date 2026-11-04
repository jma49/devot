# Devot's directory plugin (not published)

The layout a plugin for Claude's directory would take, kept here until the owner decides to publish it. Nothing here is published, and no public repository exists for it. Copied to the root of a public repository, the folder is both the plugin and a marketplace that lists it, so users could add it with Customize > Plugins > Add marketplace, or in Claude Code:

```
/plugin install devot --marketplace <owner>/<repo>
```

- `.claude-plugin/plugin.json`: the plugin's manifest. It sets no `version`, so each commit of the repository is a new version and users get the launcher's changes without a version bump.
- `.claude-plugin/marketplace.json`: the marketplace, listing this folder (`./`) as its one plugin.
- `.claude-plugin/icon.png`: the app icon (`src-tauri/icons/icon.png`). The directory takes a listing icon only the first time a plugin is saved there.
- `.mcp.json`: one MCP server, `devot`, run by `/bin/sh` from the plugin's own folder.
- `scripts/devot-mcp.sh`: the launcher, byte for byte the one Settings puts in its `.mcpb` (`src-tauri/mcp/devot-mcp.sh`; `tests/core/mcp-tools.test.ts` holds them alike, `tests/core/mcp-launcher.test.ts` runs it). It runs `devot --cli mcp` from the app it is given as its first argument, else from `/Applications`, else from `~/Applications`. It never searches for the bundle identifier elsewhere: any copy can claim it (one unpacked in `~/Downloads`, say), and the launcher does not check signatures. It holds no server, no token and no notes, so the plugin stays a few KB and follows the app's updates. It is not in `bin/`: claude.ai and Cowork do not install a plugin with that folder.

With no Devot on the Mac it exits with `E_MCP_APP_NOT_FOUND` and a line saying where to get Devot on stderr, so a client shows a failed server rather than a tool. Everything else is as for any client: AI tools stay off until the owner allows them in Settings > Integrations, and notebooks until the owner allows each one (ADR 0012).

Check the layout with `claude plugin validate docs/mcp-plugin`, and try it with `claude --plugin-dir docs/mcp-plugin`.

## Still undetermined

- Whether the directory takes a plugin that needs an app installed first, and how a listing says so.
- The privacy policy's address (`privacyPolicyUrl` in the manifest) and the contact address the submission asks for.
- Whether a plugin may turn on Allow AI Tools by itself. It cannot today: a first call answers `E_MCP_ACCESS_OFF` until the owner turns it on in Settings, and the hint says where.
