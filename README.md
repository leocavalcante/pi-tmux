# pi-tmux

A [Pi](https://pi.dev) extension that names your tmux window from the current
task and active conversation history. It also marks windows and tmux sessions
when Pi is waiting for input.

A prompt about fixing authentication tests might produce `fix auth tests`.
Follow-ups such as `continue` or `yes, do it` use recent dialogue to keep the
task recognizable. Resuming a Pi session restores a task title without a new
prompt. Naming runs in the background and does not delay Pi's answer.

| State | Window name | tmux session name |
| --- | --- | --- |
| Pi is working alone in its window | `fix auth tests` | Existing name |
| Pi has settled and is waiting for input | `* fix auth tests` | `* ` plus the existing name |
| Pi quits, another Pi remains in the window | Current task title, marked if a remaining pane is waiting | Existing name, still prefixed if another Pi pane is waiting |
| Last Pi in a window quits normally | `zsh` | Existing name, still prefixed if a Pi pane in another window is waiting |

Generated and pinned task titles are lowercase and limited to 24 ASCII
characters, including the waiting prefix. tmux session names keep their
original text and length. The waiting marker means at least one Pi pane has
stopped running, not that the task succeeded. A window stays marked while any Pi pane in that window waits.
A session stays marked while any Pi pane across its windows waits.

## Installation

Run interactive Pi inside tmux, with `tmux` available on `PATH` and
`TMUX_PANE` set by tmux. Tested with Pi 1.0.4. The package declares Node.js
22.19 or newer; Pi supplies the runtime dependencies, with no build step.

```sh
pi install npm:@leocavalcante/pi-tmux
```

Or install from GitHub:

```sh
pi install git:github.com/leocavalcante/pi-tmux
```

Run `/reload` in Pi after installation. If you previously used the local
`tmux-title` extension, remove that copy before loading this package to avoid
running two naming requests for each prompt.

To update an existing installation:

```sh
pi update npm:@leocavalcante/pi-tmux
```

For a GitHub installation, use `pi update git:github.com/leocavalcante/pi-tmux`
instead.

Run `/reload` in each running Pi instance afterward so busy panes register
window ownership. Waiting panes from older runtimes are still recognized from
their waiting flags.

### Naming model

The default naming model is `openai-codex/gpt-6-luna`, using your existing Pi
credentials. Authenticate with `/login` and make sure that model is available.
This does not change the model used for your main conversation.

Set `PI_TMUX_MODEL` before starting Pi to use another registered model:

```sh
PI_TMUX_MODEL=anthropic/claude-sonnet-4-5 pi
```

Use `provider/model` as listed by Pi. Model IDs can contain additional slashes,
such as `openrouter/vendor/model`. An unset or blank setting uses the default.
The extension reads this setting when it loads. Changes to a parent shell's
exports require restarting Pi; `/reload` rereads Pi's own process environment.
An invalid setting disables naming and warns without falling back to another
provider. A missing model or missing credentials also does not trigger fallback.

For waiting markers without any naming requests or dialogue collection:

```sh
PI_TMUX_MODEL=off pi
```

Status-only mode still formats waiting window names. The last Pi in a window
resets its name to `zsh` on graceful quit. You can set a manual title without
enabling AI naming.

### Retry a title

Run `/tmux-title` inside interactive Pi in tmux to refresh from the active
session context. It retries even when the context matches a failed request,
cancels any outstanding naming request, and preserves the current waiting
status. The bare command returns without waiting for the model. An empty
session makes no request. AI naming must be enabled, with no manual pin active.

Type `/tmux-title ` to see argument suggestions in Pi's editor. Completion
filters `status`, `sync`, `set <name>`, and `auto` as you type. Choosing `set`
inserts `set ` so you can enter the name, not a literal `<name>` placeholder.
Completion does not read dialogue or task names, make AI or tmux requests,
or replace text after `set `.

### Pin a manual title

```text
/tmux-title set fix auth tests
/tmux-title auto
```

`set <name>` pins a title for this Pi pane and cancels outstanding AI naming.
New input, settlement, and compaction keep the pinned text while waiting
markers still update. The extension does not collect naming context or make
naming requests while the pin is active. Manual titles use the same lowercase,
ASCII, and length rules as generated titles, and work with `PI_TMUX_MODEL=off`.
Empty names and names containing no letters or numbers are rejected. If a
tmux update fails, the pin stays active but the command warns instead of
confirming success. Repeat `set <name>` or use `sync` to retry.

`auto` releases the pin and requests a title from the active context. It respects
`PI_TMUX_MODEL=off` and does not clear the current waiting marker. The manual
title stays until a new name succeeds. Pins are in-memory, not saved to Pi
history. Session replacement, tree navigation, reload, and quit release them.
A bare `/tmux-title` leaves an active pin alone.

### Inspect title status

Run `/tmux-title status` for a read-only snapshot of the title mode, naming
configuration, pending naming work, and local waiting state. It shows pane,
window, and session IDs, their waiting flags, and queued former-location repairs.

Status makes no AI requests, collects no dialogue, and does not change titles,
flags, pins, or pending naming work. It omits names, model-setting values, and
provider errors. `AI naming: configured` means the setting is valid, not that
the model or its credentials are available. Snapshot values may change while
Pi is working; run the command again for a fresh reading.

### Synchronize without AI

Run `/tmux-title sync` to reapply this pane's task title and waiting/ownership
flags, and retry former-location repairs. Use it after moving a pane or when
tmux has recovered from a failed update. It works with AI naming off, missing
credentials, or an invalid naming setting.

Sync collects no dialogue and does not access models or credentials. It keeps
the title mode, local waiting state, and pending naming request unchanged.
A completed, current naming result can be applied; a pending result can still
update the title later. Like other title updates, sync can replace a peer's
task title in a shared window. Without a task title, an unmarked custom name
stays intact.

Success messages only confirm current, successful updates. Failed updates warn;
superseded, disposed, or continuously moving updates do not announce success.
If some former-location repairs remain queued, sync reports that separately.
Repeat the command to retry them.

## Behavior

- With AI naming enabled and no manual pin, each non-empty interactive prompt
  requests a title using recent dialogue from the active session branch plus
  the new prompt.
- Startup, resume, fork, reload, and tree navigation request a title from the
  active session context. Compaction refreshes it from the compacted context.
- Final settlement refreshes the title when the assistant's text adds context.
  Identical bounded context does not start another request.
- An empty Pi session makes no naming request and preserves an unmarked custom
  window name. Lifecycle events still update waiting markers.
- Context comes from Pi's active session projection. Abandoned branches,
  compacted originals, and text removed by Pi context edits are not used.
- Titles are forced to lowercase and clipped at a word boundary when possible.
- `* ` marks a fully settled run, after tool work, retries, and queued
  continuations are finished. It does not mean the task succeeded.
- The 24-character limit includes the marker. Waiting titles reserve two
  characters for `* `, leaving up to 22 for the task name.
- New input, another run, session replacement, reload, and graceful shutdown
  clear that pane's waiting flag. Window and session markers remain while
  another pane in their scope is waiting. Marker updates make no additional
  model calls and still work if the naming model is unavailable.
- The extension targets the window and session containing Pi's `TMUX_PANE`,
  even if you have switched focus elsewhere. Renames use the pane ID so a
  move after the title lookup does not rename its former window or session.
  After marker writes, the window title is read again so a move during that
  update does not copy the source title or incorrectly skip quit cleanup.
- Window markers aggregate waiting Pi panes in that window. Session markers
  aggregate waiting Pi panes across all windows. A busy or exiting pane cannot
  clear another pane's marker. Window renames choose the prefix and its length
  budget on the tmux server, even if another pane changed status after lookup.
  Session names are not summarized, lowercased, or clipped. A literal leading
  `* ` is preserved, with the waiting marker added separately. The extension
  keeps each session's unmarked name in the namespaced
  `@pi-tmux-session-base-name` tmux session option so it can distinguish a
  literal prefix from its marker across status updates. On first seeing a
  session with no stored base, the extension preserves its displayed name;
  an old waiting marker left by an earlier version may therefore appear twice
  on a later waiting update rather than risking loss of a literal prefix.
- Changed naming context cancels the previous request, including when a
  refresh finds no remaining naming text after context edits. It also discards
  queued title updates from superseded requests at tmux command boundaries.
  Later status updates keep the previously applied title rather than reusing a
  discarded model result. Session changes, tree navigation, reload, and shutdown
  cancel outstanding work too.
- Naming requests use SSE, with reasoning, retries, and cache retention
  disabled. Requests have a 15-second timeout and a 96-token output cap.
  The extension stops waiting at the deadline even if a provider ignores
  cancellation. It clears its pending state, timer, and abort listener, and
  ignores late results or failures. A provider that ignores aborts may still
  keep its underlying request alive. Cancellation from new input or lifecycle
  changes releases the extension's timer and listener without waiting for it.
- Print, JSON, and RPC modes do not update tmux names or markers.
  Extension-injected input does not directly request a title; later refreshes
  can include resulting dialogue.
- Naming failures keep the existing task name; waiting status can still
  update. At most one automatic warning appears per extension load. Identical
  context is not retried automatically after a failed naming request.
  `/tmux-title` allows another warning if the explicit retry fails.

### Shared panes and cleanup

Multiple interactive Pi panes in one tmux window share its task title. The
most recent task-title update wins, including manual pins. Quitting one Pi
keeps the current shared task title while another Pi remains in that window,
whether it is busy or waiting. Cleanup chooses ownership and reads the latest
shared title on the tmux server, so a peer that starts or renames after lookup
is protected too. A peer in a different window does not prevent `zsh` cleanup.
The waiting marker aggregates all Pi panes in its window independently of
which pane last named it. A waiting pane in a different window marks the
session but not this window.

Renaming turns off tmux's automatic process-based naming for that window.
The last Pi to quit gracefully resets the name to `zsh`, regardless of your
actual shell, and does not re-enable automatic naming. `/reload` and Pi session
replacement keep ownership registered, clear that pane's waiting status, then
refresh the task name from the active history. The existing task name stays
until a naming request succeeds.

A forced kill cannot run cleanup and may leave task names, waiting flags, or
ownership flags behind. If Pi has stopped but its pane remains, clear only that
pane's stale flags before relying on another Pi's next status update:

```sh
tmux set-option -p -t <pane-id> @pi-tmux-active 0
tmux set-option -p -t <pane-id> @pi-tmux-waiting 0
```

Pane moves do not trigger an immediate update. The moved Pi's next status
update also refreshes its most recently observed former window and session
markers. `/tmux-title sync` performs this update on demand without an AI
request. Repair uses each window's latest task text and respects other panes'
waiting flags. Unmarked custom window names and their automatic-rename setting
stay unchanged. Vanished targets are ignored; transient failures are retried
on later status updates. Tracking is in memory, limited to eight former windows
and eight sessions. If the pane keeps moving during repair, each update makes
at most four passes; remaining repairs wait for a later update. No tmux hooks
are installed.

Closing a pane without a graceful Pi shutdown cannot run repair. A Pi remaining
in the former location must refresh it. To restore automatic process-based
names instead:

```sh
tmux set-window-option -t <window-id> automatic-rename on
```

## Privacy and security

With AI naming enabled, the configured naming model receives up to 6,000
characters of task context:

- The first 2,000 characters of your new prompt, when present.
- Up to eight recent user, assistant, or branch-summary text entries, each
  capped at 1,000 characters. Older entries are omitted to fit the total cap.
- The latest active compaction summary, capped at 1,000 characters.

Images, thinking blocks, tool calls, tool results, shell output, system prompts,
and custom extension messages are excluded. Summaries and ordinary dialogue
can still mention details from tool output. Provider billing, subscription
limits, and data handling apply to these additional requests. A run can request
a title on input and again at settlement when its context changes. Each
`/tmux-title` retry also makes a request when naming context is available.
`PI_TMUX_MODEL=off` or an active manual pin prevents these naming requests.
Manual title commands do not send the title or dialogue to a model.

The model is instructed not to include secrets or personal information in
titles, but this is not a redaction guarantee. Do not put secrets into prompts.
Window names are visible in your tmux status bar and may be retained by tmux
session-persistence plugins.

This extension does not write prompts, responses, or credentials to files,
and it does not print provider error payloads. Authentication is resolved by
Pi. tmux runs with argument arrays, not interpolated shell commands. Generated
and pinned titles are sanitized before insertion into fixed tmux formats.
Existing shared titles come from format variables after command parsing.
Marker repair uses `if-shell -F` to evaluate a format without invoking a shell.
Title text cannot inject shell commands, tmux options, or additional format
expressions.

Like other Pi extensions, it runs with the same OS permissions as Pi. This
repository contains source and synthetic tests only. Keep credentials,
sessions, model caches, environment files, and personal Pi configuration out
of contributions. `.gitignore` is a precaution, not a substitute for reviewing
the staged diff and scanning for secrets.

## Development

```sh
git clone https://github.com/leocavalcante/pi-tmux.git
cd pi-tmux
npm ci --ignore-scripts
npm run check
npm test
```

- `index.ts` contains the extension, title formatting, context selection, and
  tmux status updates.
- `tests/title.test.ts` covers formatting, context bounds and exclusions,
  naming cancellation, model configuration, empty window-name fields, status-only
  mode, explicit retries, manual pins, read-only diagnostics, model-free sync,
  truthful confirmations, lifecycle events, waiting markers, and failures with
  mock model responses and tmux commands.
- `tests/session.test.ts` checks window and session aggregation, shared-window
  ownership, concurrent status and ownership changes at rename time, and pane
  moves against a separate temporary tmux server with no user configuration.
  It skips if tmux is unavailable.
- `tests/move.test.ts` checks former-location marker repair, remaining peers,
  custom names, vanished targets, repeated moves, explicit sync retries, and superseded repairs
  on isolated tmux servers. Those checks skip if tmux is unavailable; the queue
  and stabilization bounds also have a mock-only regression.
- `tests/status.test.ts` verifies read-only diagnostic snapshots and waiting-flag
  aggregation on an isolated tmux server. It skips if tmux is unavailable.
- `tests/package.test.ts` checks that the Pi extension entrypoint is pack-listed
  and loads after TypeScript erasure without a runtime SDK dependency.

Development tests require Bun. The tmux integration tests use separate temporary
servers and skip automatically when `tmux` is unavailable; install tmux to run
that integration coverage. The integration fixtures use Unix paths (`/dev/null`
and `/bin/sleep`), so run them on a Unix-like host such as Linux, macOS, or WSL.
Mock-only tests, including empty window-name parsing, do not need tmux. GitHub
Actions runs the type check, tests, and package-content check on Linux with
Node.js 22 and 24 and Bun 1.4.2. The tests make no model API calls and do not
rename your windows or sessions.

Try the checkout in Pi without changing your settings:

```sh
pi --extension ./index.ts
```

Use either the installed package or the development extension, not both.

Before publishing changes, review the staged files and scan with
[Gitleaks](https://github.com/gitleaks/gitleaks):

```sh
git diff --cached --check
gitleaks dir . --redact
gitleaks git . --redact
```

## Publishing

GitHub Actions tests pushes and pull requests. Publishing a stable GitHub
release tagged `v<package.json version>`, such as `v0.1.0`, runs the same test
matrix before publishing `@leocavalcante/pi-tmux` to npm with provenance.
Prereleases are not published. Bump `package.json` and `package-lock.json`
together before each new release. npm versions cannot be overwritten.

The publishing workflow uses npm Trusted Publishing with GitHub OIDC. It does
not use an npm token or an Actions publishing secret.

npm requires the package to exist before configuring a trusted publisher.
Bootstrap version `0.1.0` once from this checkout using interactive npm login
and 2FA, without creating a CI token:

```sh
npm login
npm ci --ignore-scripts
npm run check
npm test
npm publish --access public --provenance=false --ignore-scripts
```

The initial local publish has no provenance. Configure the package's trusted
publisher on npm using GitHub owner `leocavalcante`, repository `pi-tmux`, and
workflow filename `publish.yml`. Leave the environment name blank and allow
`npm publish`. The workflow must already exist on GitHub.

After configuring trust, select "Require two-factor authentication and disallow
tokens" in npm's publishing access settings. Bump to a new version, such as
`0.1.1`, before publishing a GitHub release. Do not run the workflow for the
already-published bootstrap version. Later releases publish through OIDC with
provenance. See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/)
and the [package-existence prerequisite](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites).

## License

[MIT](LICENSE).
