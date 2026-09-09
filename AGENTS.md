# AGENTS.md

## Project

`dsh-tabbit` — Tabbit Browser bundle for DeepSeek Harness (DSH): a code-first
`tabbit_browser` tool, browser-backed `web_fetch`, `@tab` composer mentions, a
dedicated page-access permission, an environment preflight with background
installer download, and a daily plugin update check. Published on npm as
[`dsh-tabbit`](https://www.npmjs.com/package/dsh-tabbit). 
repo:`Tabbit-Browser/dsh-tabbit`.

## Conventions

- TypeScript ESM (`"type": "module"`), built with `pnpm build` (tsc → `lib/`,
  gitignored). Type resolution for `@deepseek-ai/*` uses `tsconfig.json`
  `paths` pointing at a local deepseek-harness checkout; runtime resolution is
  peerDependencies via the DSH profile's flat `node_modules` fallback.
  peerDependencies state the HOST DSH floor (currently `0.1.2-alpha.1`, not
  reliably on npm — most `@deepseek-ai/dsh-*` packages there are stuck many
  minors behind) — `.npmrc` turns `auto-install-peers` off, and the packages
  the tests actually import at runtime (schemastery, dsh-tools, dsh-llm,
  dsh-session, dsh-web) are `link:` devDependencies into the same checkout.
  Both the `paths` entries and the `link:` targets point at `./.dsh-harness`
  — a gitignored symlink, not a real directory — so neither file needs
  per-developer edits: point that one symlink at your own checkout with
  `npm run link-harness -- /path/to/deepseek-harness` (or set
  `DSH_HARNESS_PATH`). See the README's Development section.
- Source comments are written in Chinese, per-function, for readers who don't
  know dsh/Node (in-depth architecture notes live in internal docs, not in
  this repo). Keep new code commented in the same style and density.
- Tests: `npm test` (builds, then `node --test tests/`). All tests must pass
  before releasing.
- The npm tarball contents are whitelisted in `package.json` `files` — verify
  with `npm pack --dry-run` after changing it.
- Install/update instructions given to users (READMEs, `SKILL.md`, update
  notice) prefer the npm route (`dsh plugin --profile web add dsh-tabbit`);
  the `github:Tabbit-Browser/dsh-tabbit` source is the documented fallback. npm
  installs are what the registry's download stats count.
- `scripts/sync-to-browser.sh` rsyncs the built package into the tab-browser
  checkout for the preinstalled (vendored) form; run it after a build when
  updating the browser-side copy.

## Release process

npm version and GitHub Release must stay in lockstep:

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry. The first
   ~500 flattened characters of the release's entry are what installs see in
   their update notice — front-load the message. `CHANGELOG.md` must stay in
   the `files` whitelist: the update check serves release notes from the
   published tarball.
   - If this release depends on harness behavior that didn't exist on the
     previously-required floor (i.e. the `peerDependencies` floor in
     `package.json` needs to move, not just get a routine bump), add a line
     `Requires DSH >= X.Y.Z-tag.N.` as the entry's first line, before the
     bullet list. `update-check.ts`'s host-compatibility filter
     (`selectCompatibleVersion`) parses this exact format out of every
     section of the published `CHANGELOG.md` to avoid offering installs on
     an older DSH host a plugin version their host can't actually run — a
     release without this line is assumed to need no higher a floor than the
     nearest earlier release that stated one (floors only rise). Omit the
     line entirely when this release doesn't raise the floor.
2. `npm test` — all tests must pass.
3. Commit (`chore: release X.Y.Z`) and push to `main`.
4. `npm publish` (runs `prepack` → build). **Publishing IS the update channel
   for 0.3.0+ installs**: their daily check reads the version from
   `registry.npmjs.org/dsh-tabbit/latest` and the release notes from the
   published tarball's `CHANGELOG.md` via jsdelivr — nothing else to update.
   (The canonical repo is private, so no raw-GitHub URL can serve them; the
   npm registry is also the only channel of these that is reachable from
   mainland China.) The npm account has security-key-only 2FA, which the npm
   CLI cannot satisfy — publish with a granular access token (read+write on
   packages, bypass 2FA) via a throwaway userconfig:
   `npm publish --userconfig <tmpfile>` where the tmpfile contains
   `//registry.npmjs.org/:_authToken=npm_...`. Delete the tmpfile afterwards;
   never commit tokens.
5. `gh release create vX.Y.Z --repo Tabbit-Browser/dsh-tabbit --target main` with
   the changelog entry as notes. This also creates the `vX.Y.Z` tag.
6. **Mirror the changelog to the legacy repo**: installs of 0.2.x poll
   `https://raw.githubusercontent.com/Tabbit-Browser/dsh-tabbit/main/CHANGELOG.md`
   daily (the URL is hardcoded in their copy of the plugin). Until that
   population ages out, every release must also land the new `CHANGELOG.md`
   entry on `Tabbit-Browser/dsh-tabbit` `main`, or those users never see the
   update offer.

## Registry entry (awesome-dsh-plugin)

The upstream registry entry lives at
`data/plugins/Tabbit-Browser__dsh-tabbit.yml` in
`awesome-dsh-plugin/awesome-dsh-plugin` and still points at the legacy repo —
it should be repointed to `Tabbit-Browser/dsh-tabbit`. READMEs there are generated
from the YAMLs — after editing an entry, run `node scripts/generate-readme.mjs`
and commit both READMEs, or CI fails. npm package detection and download stats
are re-probed daily by upstream automation; no manual cache edits.
