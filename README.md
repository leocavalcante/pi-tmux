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
| Last Pi in a window quits normally | `zsh` by default; configurable | Existing name, still prefixed if a Pi pane in another window is waiting |

Generated and pinned task titles are lowercase and limited to 24 ASCII
characters, including the waiting prefix. tmux session names keep their
original text and length. The waiting marker means at least one Pi pane has
stopped running, not that the task succeeded. A window stays marked while any Pi pane in that window waits.
A session stays marked while any Pi pane across its windows waits.

## Installation

Run interactive Pi inside tmux, with `tmux` available on `PATH` and
`TMUX_PANE` set by tmux. Linux CI exercises tmux 3.4 and a pinned tmux 3.7c
build; macOS CI uses the runner's installed version. These are tested versions,
not a stated minimum-version requirement. Tested with Pi 1.1.0. The package
declares Node.js 22.19 or newer; the Pi extension API peer range is `^1.1.0`.
Pi supplies the runtime dependencies, with no build step.

The npm package has not been published yet, so install from GitHub for now:

```sh
pi install git:github.com/leocavalcante/pi-tmux
```

After the npm bootstrap publish is complete, npm installation will also be
available:

```sh
pi install npm:@leocavalcante/pi-tmux
```

Run `/reload` in Pi after installation. If you previously used the local
`tmux-title` extension, remove that copy before loading this package to avoid
running two naming requests for each prompt.

To update a GitHub installation:

```sh
pi update git:github.com/leocavalcante/pi-tmux
```

After installing from npm, use `pi update npm:@leocavalcante/pi-tmux` instead.

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

Use `provider/model` as listed by Pi. The setting is trimmed at the edges and
may contain at most 256 ASCII characters afterward. Provider IDs may contain
visible punctuation other than `/`; model IDs may contain additional slashes.
Whitespace and control characters inside either ID are rejected. The first
slash separates provider from model, so `openrouter/vendor/model` uses
`openrouter` as the provider and `vendor/model` as the model. An unset or blank
setting uses the default; `off` (case-insensitive) disables naming.
The extension reads this setting when it loads. Changes to a parent shell's
exports require restarting Pi; `/reload` rereads Pi's own process environment.
An invalid setting disables naming and warns without falling back to another
provider. A missing model or missing credentials also does not trigger fallback.

The last Pi pane normally resets its window to `zsh` when it quits. Set
`PI_TMUX_IDLE_TITLE` before starting Pi to choose another idle title; the value
uses the same lowercase ASCII cleanup and 24-character limit as generated
names. Empty or non-alphanumeric values, values longer than 64 Ki UTF-16 code
units, and values matching the limited sensitive-output checks fall back to
`zsh`; these checks are best-effort, not comprehensive redaction. The value
applies only on a future graceful quit when this is the last Pi pane in its
window; it does not rename an open window.
`/reload` rereads the setting from Pi's process environment.

For waiting markers without any naming requests or dialogue collection:

```sh
PI_TMUX_MODEL=off pi
```

Status-only mode still formats waiting window names. The last Pi in a window
resets its name to the configured idle title on graceful quit. You can set a
manual title without enabling AI naming.

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
or replace text after `set `. Arguments longer than 128 Ki UTF-16 code units are
rejected with a generic warning; autocomplete returns no suggestions for prefixes
over the same limit. Rejected input is not echoed.

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
Inputs longer than 64 Ki UTF-16 code units are rejected before screening to
bound work. Empty names and names containing no letters or numbers are rejected.
Values matching the limited sensitive-output checks are also rejected before
cleanup, so obvious credentials or personal data are not pinned. This is not
comprehensive redaction. If a tmux update fails, the pin stays active but the
command warns instead of confirming success. Repeat `set <name>` or use `sync`
to retry.

`auto` releases the pin and requests a title from the active context. It respects
`PI_TMUX_MODEL=off` and does not clear the current waiting marker. The manual
title stays until a new name succeeds. Pins are in-memory, not saved to Pi
history. Session replacement, tree navigation, reload, and quit release them.
A bare `/tmux-title` leaves an active pin alone.

### Inspect title status

Run `/tmux-title status` for a read-only snapshot of the title mode, naming
configuration, pending naming work, and local waiting state. It shows pane,
window, and session IDs, their waiting flags, and queued former-location repairs.

Status makes no AI requests, collects no dialogue, and never writes titles or
flags to tmux. It omits names, model-setting values, and provider errors.
`AI naming: configured` means the setting is valid, not that the model or its
credentials are available. Status checks the tmux server identity in its
snapshot. If it detects a restart, it fails closed locally, cancelling naming
and discarding state tied to the old server; restart Pi to reconnect safely
because the inherited pane ID may have been reused. Until then,
`/tmux-title`, `/tmux-title auto`, `/tmux-title sync`, and `/tmux-title set <name>`
warn that Pi must restart. Snapshot values may change while Pi is working; run
the command again for a fresh reading.

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
  window name. Lifecycle waiting markers, quit cleanup that retains a live
  peer's title, and former-window repairs preserve long custom text without
  applying task-title casing or length rules.
- Context comes from Pi's active session projection. Abandoned branches,
  compacted originals, and text removed by Pi context edits are not used. To
  bound work in tool-heavy sessions, history selection inspects at most the
  latest 4,096 projected messages; the current prompt and compaction summary
  are handled separately. Per-message text extraction inspects at most 128
  content blocks and scans no more than 1,000 leading whitespace code units.
- Titles are forced to lowercase and clipped at a word boundary when possible.
- If the provider supplies phase metadata, only `final_answer` blocks are
  considered. When metadata is present but no final block exists, output is
  rejected rather than falling back to the last text block; without phase
  metadata, the last text block is used. Responses with more than 128 content
  blocks are rejected; signatures over 4 Ki UTF-16 code units are treated as
  unrecognized metadata. If a provider ignores the requested
  96-token cap and selected output exceeds 64 Ki UTF-16 code units, it gets one
  correction attempt and is not applied as-is. Other overlong or over-worded
  first candidates also get one correction request. A still-overlong candidate
  is clipped at a word boundary only when it remains a 2–4-word title; multiline,
  over-word, and otherwise unusable output is rejected.
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
  update does not copy the source title or incorrectly skip quit cleanup. Each
  write batch also checks the server PID from its lookup on the tmux server; a
  restart between lookup and write therefore cannot apply cached numeric IDs to
  a replacement server. If a later lookup detects a new server, this extension
  instance cancels naming and stops writing because `TMUX_PANE` may now refer to
  an unrelated pane that reused the old ID.
- Window markers aggregate waiting Pi panes in that window. Session markers
  aggregate waiting Pi panes across all windows. A busy or exiting pane cannot
  clear another pane's marker. Window renames choose the prefix and its length
  budget on the tmux server, even if another pane changed status after lookup.
  Session names are not summarized, lowercased, or clipped. A literal leading
  `* ` is preserved, with the waiting marker added separately.
  Control characters, backslashes, and other characters that tmux escapes in a
  formatted name may not round-trip through rename commands; the exact escaping
  can vary between tmux versions. If a custom session name's formatted value
  contains unsafe escapes, its session marker is skipped; an unsafe formatted
  window name skips its waiting marker when no task title is available. Names
  are preserved, pane flags and any safe marker still update, and a generic
  warning is shown. For names that can be safely renamed, the extension keeps
  each session's unmarked name in the namespaced
  `@pi-tmux-session-base-name` tmux session option so it can distinguish a
  literal prefix from its marker across status updates. Window names use the
  same stored-base approach to distinguish a
  literal prefix when waiting state or a leading `* ` makes the marker
  ambiguous, using the namespaced `@pi-tmux-window-base-name` option. On first
  seeing an existing session or window with no stored base, the
  extension preserves its displayed name; an old waiting marker left by an
  earlier version may therefore appear twice on a later waiting update rather
  than risking loss of a literal prefix. The server skips a window rename when
  its displayed name is already correct, so startup preserves automatic-rename.
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
is protected too. A peer in a different window does not prevent idle-title
cleanup.
The waiting marker aggregates all Pi panes in its window independently of
which pane last named it. A waiting pane in a different window marks the
session but not this window.

Renaming turns off tmux's automatic process-based naming for that window.
The last Pi to quit gracefully resets the name to the configured idle title
(`zsh` by default), regardless of your actual shell, and does not re-enable
automatic naming. `/reload` and Pi session replacement keep ownership
registered, clear that pane's waiting status, then
refresh the task name from the active history. The existing task name stays
until a naming request succeeds.

A forced kill cannot run cleanup and may leave task names, waiting flags, or
ownership flags behind. If Pi has stopped but its pane remains, run these
commands from the shell in that pane to clear only its stale flags before
relying on another Pi's next status update:

```sh
tmux set-option -p -t "$TMUX_PANE" @pi-tmux-active 0
tmux set-option -p -t "$TMUX_PANE" @pi-tmux-waiting 0
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
names for a window, run this from a shell in one of its panes:

```sh
tmux set-window-option -t "$TMUX_PANE" automatic-rename on
```

## Privacy and security

With AI naming enabled, a naming request can send up to 6,000 characters of
task context to the configured model:

- Up to 2,000 characters from your new prompt. Oversized prompts retain both
  ends around `[... middle of prompt omitted ...]`; shorter prompts are included
  in full.
- Up to eight recent user, assistant, or branch-summary text entries, each
  capped at 1,000 characters. Older entries are omitted to fit the total cap.
- The latest active compaction summary, capped at 1,000 characters.

Images, thinking blocks, tool calls, tool results, shell output, system prompts,
and custom extension messages are excluded. Summaries and ordinary dialogue
can still mention details from tool output. Before model lookup or provider
transport, the bounded context is checked locally with limited patterns for
recognizable credentials. These include selected provider-specific formats
(for example GitHub, GitLab, PyPI, and Tailscale keys, Stripe webhook signing
secrets, Discord, Slack, and Microsoft Teams webhook URLs, Azure DevOps PATs,
Google OAuth/API keys, and other service tokens), npm `.npmrc` `_auth`
username/password pairs and legacy Base64 `_password` values, credential-bearing
URLs, Bearer and Base64 Basic authorization values, and long values assigned to
common credential labels.
For supported credential labels, YAML block scalars with tags or anchors are
also checked, as are shorter non-placeholder password/passphrase assignments.
The context scanner also checks conventional email addresses and explicitly
labeled U.S. SSN-, phone-, and Luhn-valid payment-card-shaped values.
If detected, the request is skipped and the current title is kept; warnings do
not include matching text, and blocked context is not kept in the extension's
deduplication cache. This is a limited, best-effort check, not comprehensive
secret redaction, so credentials that do not match can still be
sent. Provider billing, subscription limits, and data handling
apply to naming requests that proceed. A run can request a title on input and
again at settlement when its context changes; an invalid length or word-count
result can trigger one short correction request. Each `/tmux-title` retry also
makes a request when naming context is available. `PI_TMUX_MODEL=off` or an
active manual pin prevents these naming requests. Manual title commands do not
send the title or dialogue to a model.

The model is instructed not to include secrets or personal information in
titles. Before applying a response, the extension checks raw and
compatibility-normalized output against the same limited set of selected
provider-specific credential formats, credential-bearing URLs, authorization
values, and labeled credential patterns. It also checks conventional email
addresses and explicitly labeled U.S. SSN-, phone-, and Luhn-valid
payment-card-shaped values. Supported YAML block-scalar forms with tags or
anchors and shorter non-placeholder password/passphrase assignments are
checked too. A view with whitespace, control, and format characters removed
catches some obfuscated values.
Rejected responses are not included in warnings. These limited checks are
defense in depth, not comprehensive secret or personal-information redaction.
Do not put secrets into prompts.
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
repository contains source and synthetic tests only.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, checks, tests, and guidance before contributing.

## Publishing

GitHub Actions tests pushes to `main` and pull requests. Publishing a stable GitHub
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
npm audit --audit-level=high
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
