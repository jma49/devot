# Releasing Devot

Until 1.0 every build ships as a GitHub prerelease on the beta channel. These rules hold until the automated release workflow replaces the manual steps; that workflow must follow the same rules.

## Versions and tags

- Tags look like `vMAJOR.MINOR.PATCH-beta.N`, for example `v0.3.0-beta.1`.
- The tag decides the version. Before building, set the same version (without the leading `v`) in `package.json` and `src-tauri/Cargo.toml`; `tauri.conf.json` takes its version from Cargo.
- Each release gets a new tag and a new prerelease. Never replace an existing release or move an existing tag.
- A feature batch landing on `main` raises MINOR and starts at `beta.1` (`v0.3.0-beta.1`, then `v0.4.0-beta.1`, ...).
- A release with only fixes on top of the latest minor raises N (`v0.3.0-beta.2`, ...).
- Stable releases start at 1.0. Until then the update feed's `stable.json` stays empty and only `beta.json` is published.

## When to release

Release only when both are true:

1. CI is green on the merge commit on `main`.
2. The batch was accepted by the reviewer who merged it.

## Build

1. `git fetch`, then create a fresh detached worktree of the merge commit on `origin/main`.
2. Copy `.env.local` into it, then `pnpm install --frozen-lockfile`.
3. Set the version as described above (a local change in that worktree; the build does not need it committed).
4. Build an ad-hoc signed bundle for Apple Silicon:

   ```sh
   CI=true PATH="$(brew --prefix rustup)/bin:$PATH" pnpm tauri build --bundles app,dmg \
     --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'
   ```

   The `"-"` signing identity is required: without it the bundle has no seal, and downloaded copies are reported as damaged.

   `CI=true` skips the step that lays out the disk image window through Finder; without a logged-in Finder session (an agent or a remote shell) that step fails and no dmg is written.

5. Verify: `codesign --verify --deep --strict <Devot.app>` and `hdiutil verify <dmg>`.

## Publish

```sh
git tag <tag> <merge commit> && git push origin <tag>
gh release create <tag> <dmg> --prerelease --title "Devot <version>" --notes-file <notes>
```

Notes are in English and list the issues the release closes, one line each (`- #148 Drag notes and notebooks out of the app as links`).

Remove the build worktree afterwards.
