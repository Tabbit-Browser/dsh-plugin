# Changelog

## Unreleased

- Fixed `finish: true, keep_tabs: true` failing to close browser tasks on
  Tabbit 1.13.20+ because its CLI rejects `--keep`
  (https://github.com/Tabbit-Browser/dsh-tabbit/issues/24). The plugin now
  retries once with a bare, keep-by-default `finish` only when the CLI
  returns that generation's usage error. Older browsers still receive
  `--keep`, and closing tabs still uses `--discard`.

## 0.3.4

- Adapted to Tabbit Browser 1.13.20+
  (https://github.com/Tabbit-Browser/dsh-tabbit/issues/23). Those builds
  removed the Runtime Service's unbound `tabs` socket operation and the
  `tasks` CLI subcommand, and 1.13.23+ rejects any `--timeout-ms` below
  60000 — which broke `list_tabs`, the `@tab` menu, browser-backed
  `web_fetch`, and `/tabbit-info`'s task list. The tab inventory now falls
  back to the CLI `tabs` command over the same socket (paged, still without
  launching the browser; the new `claimed` state maps to `busy`), task
  listing reads `diagnose` first and only then the legacy `tasks`, and
  evaluation timeouts are clamped to 60000–120000 ms, the range both old and
  new browsers accept. The internal CLI subprocess timeout grew to 170 s to
  cover the new CLI's longer wait.
- `/tabbit-info` now opens its details with the plugin version and the host
  DSH version (`plugin: dsh-tabbit 0.3.4 · host dsh 0.1.5-alpha.2`), so a
  bug report says which copy is actually loaded — a profile that links a
  local checkout can silently keep serving an older one.
- `/tabbit-info` no longer appends a custom `tabbit/status` event to the
  session log. DSH refuses to read a session containing an event type it
  does not know unless that event is marked `ignorable`, and a plugin has no
  way to set that marker through `Session.append` — so a single
  `/tabbit-info` run made the whole session unopenable after a restart
  (https://github.com/Tabbit-Browser/dsh-tabbit/issues/22). The report now
  travels as ordinary command text; the web client's status card, which was
  driven by that event, is removed with it. A session already affected can
  be repaired by adding `"ignorable": true` to each stored `tabbit/status`
  record.

## 0.3.3

Requires DSH >= 0.1.1-rc.2.

- Restored web-client compatibility with DSH `0.1.1-rc.2`. The client no
  longer hard-injects either generation of the conversation service: it uses
  `uiConversation.events` on DSH `0.1.2-alpha.1+` and falls back to
  `conversationEvents` on `0.1.1`, so neither host remains pending while
  waiting for the other generation's service name.

## 0.3.2

- `tabbit_browser` gains `list_tasks: true`: a zero-side-effect readback of
  the browser tasks this session already has open (which one an omitted
  `task` would target next), read from the in-memory session registry only.
  A memory jog for when the model has lost track after a gap in the
  conversation, instead of guessing a task name or opening a redundant one.
- `claim_tabs` now works when the task already exists, not only when the
  same call creates it. Runtime Service silently drops a creation-time
  `--claim-tab` on a reused task, so previously the plugin threw
  `CLAIM_REQUIRES_NEW_TASK` and forced starting a fresh task just to attach
  a tab the user pointed at mid-conversation. It now falls back to the
  standalone `claim` CLI command for tasks the session already knows about,
  so an already-open tab can join ongoing browser state instead of always
  starting over.
- Fixed the bundled `SKILL.md`'s frontmatter parser assuming LF-only line
  endings: a copy checked out or published with CRLF endings would have had
  its raw YAML header served to the model as skill content instead of being
  stripped.

## 0.3.1

Requires DSH >= 0.1.2-alpha.1.

- Fixed the web client plugin never activating on current DSH hosts — the web
  UI showed `dsh-tabbit: pending (waiting for service: conversationEvents)`.
  The DSH client runtime refactor (already part of `0.1.2-alpha.1`) renamed the
  `conversationEvents` service to `uiConversation` and moved node registration
  from `service.register()` to `service.events.register()`. The client plugin
  now injects `uiConversation`; the `/tabbit-info` status card, the `@tab`
  composer source, and the watching-instance hint all had been blocked behind
  that pending inject and work again. The `conversation.chat.node` keyed slot
  registration and the Definition contract (`match`/`start`/`update`/
  `buildViewNode`) are unchanged.

## 0.3.0

Requires DSH >= 0.1.2-alpha.1.

- Major upgrade: browser automation now runs through the native
  `tabbit_browser` tool — real Playwright code executing in the user's Tabbit
  Browser profile with shared login state, screenshots into model context,
  automatic interruption recovery, and multi-instance resolution — plus a
  browser-backed `web_fetch` provider, `@tab` page mentions in the dsh web
  composer, a dedicated page-access permission, and a `/tabbit` diagnostics
  command. The bundled skill now teaches the tool workflow instead of the
  `tabbit-cli` shell workflow. Requires Node 22.19 or newer (was 20).
- Adopted the renamed `tabbit-cli` launcher that current Tabbit Browser
  builds register (with fallback to the legacy `tabbit-playwright` name), and
  the per-instance `.product` labels in the instance registry.
- New model-free tab inventory: `ctx.tabbit.listAllTabs()` and the loopback
  route `GET /tabbit/tabs` list every tab of the running browser profile
  (including the user's own tabs) by talking to the Runtime Service endpoint
  directly — no launcher process, no task, no side effects, ~1ms steady-state.
  Requires a 1.11.16+ Tabbit Browser; the browser is never launched for a
  listing, offline instances report as unavailable instead.
- The `@` mention menu in the dsh web composer now lists the user's own
  browser tabs alongside agent task pages (active tab first; only http(s)
  pages are offered, since chrome://, extension, and blank/new-tab pages
  cannot deliver content when mentioned), under a "网页标签" group shown
  below DSH's built-in file/session mentions, with up to 50 candidates
  instead of 8. Mentioning a user tab fetches a fresh copy of that URL's
  content through the shared browser fetch task — the user's actual tab is
  never claimed, moved, or focused. The extracted page text no longer lands
  in the sent message itself: the composer sends a short `@Title` mention,
  and the full text is delivered to the model as a separate, collapsed
  "Context injection" entry via an `agent/pre-step` hook — the same delivery
  path DSH's own `@file`/`@session` mentions use — so a mentioned page's
  content never floods the visible chat bubble. `tabbit_browser` gained
  `list_tabs: true` for the model-facing version of the same inventory, paired
  with `claim_tabs` to attach a specific user tab to a new task.
- Windows support: the launcher is discovered under
  `%LOCALAPPDATA%\Tabbit\LocalAgent\bin\tabbit-cli.exe`, instance selection
  defers to the native CLI when the instance registry is not readable, and the
  environment preflight falls back to runtime-process detection.
- The environment preflight (`tabbit_browser_install`), the daily plugin
  update check, and the `tabbit_plugin_update` tool carry over from 0.2.x.
  The update check now reads the npm registry for the latest version (with
  release notes served from the published tarball), and stays silent for
  browser-managed (preinstalled) copies, which update together with Tabbit
  Browser.
- The bundled skill gained references for the runtime interaction helpers
  (`tabbit.observe`, `pasteText`, `triggerAndObserve`, …) and AI-mode ARIA
  snapshot recipes for canvas-backed and visually complex surfaces. It is now
  named `tabbit`, deliberately matching the shared skill Tabbit Browser
  installs into `~/.agents/skills/tabbit/`: DSH's same-name precedence
  prefers that browser-managed copy, and the bundled one is the fallback for
  machines without a current browser. The `/tabbit` diagnostics command was
  renamed to `/tabbit-info` to leave the `/tabbit` slash entry to the skill.
- Task finishing adapted to the new runtime semantics (plain `finish` now
  retains tabs as a resumable group): the plugin always passes an explicit
  `--keep` or `--discard`, which behaves correctly on both CLI generations,
  so `finish` without `keep_tabs` and end-of-session cleanup reliably close
  task tabs.
- DSH `0.1.2-alpha.1` also ships its own direct-HTTP `web_fetch` provider and
  pins the `web` service to it; the bundle patch now re-pins `fetchProvider`
  to this plugin's browser-backed provider, keeping JS rendering, login
  state, the page-access/intranet permission gates, and the browser's proxy
  environment (the built-in fetcher connects directly to resolved public IPs
  and refuses every domain on fake-ip proxy setups).
- The standard agent preset now ships with `web_fetch` enabled — the bundled
  "Tabbit mode" preset is gone, and plugin activation removes a previously
  installed managed copy (marker protocol respected: user-owned copies are
  never touched).

## 0.2.3

- Fixed the bundle's `cordis.patch.yml` loader entry to use the npm package
  name `dsh-tabbit` instead of the non-existent package `tabbit-browser`. This
  resolves the `Cannot find package 'tabbit-browser'` load failure that
  affected fresh installs after the package was renamed in 0.2.1.

## 0.2.2

- Install and update commands now use the npm package (`dsh plugin add
  dsh-tabbit`) as the primary route — prebuilt tarball, CDN-served, and
  counted in npm download stats; the `github:` source remains documented as
  a fallback.

## 0.2.1

- Renamed the package to `dsh-tabbit` and published it to npm; updated all
  remaining references (daily update-check changelog URL, install commands in
  the plugin, skill, and READMEs) from `Tabbit-Browser/dsh-plugin` to
  `Tabbit-Browser/dsh-tabbit`.

## 0.2.0

- Added a daily plugin update check. Loading the skill compares the installed
  plugin version with the published changelog — cached for 24 hours, at most
  one request per day, silent when offline — and, when outdated, asks the user
  whether to update, showing what the new version added.
- Added the `tabbit_plugin_update` tool. It records a version the user declined
  so the skill stops announcing it, and can force a recheck after a plugin
  update or a connectivity change.
