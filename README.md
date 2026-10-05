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
| Pi is working | `fix auth tests` | Existing name |
| Pi has settled and is waiting for input | `* fix auth tests` | `* ` plus the existing name |
| Pi quits normally | `zsh` | Existing name, still prefixed if another Pi pane is waiting |

Window titles are lowercase and limited to 24 ASCII characters, including the
waiting prefix. tmux session names keep their original text and length. The
waiting marker means Pi has stopped running, not that the task succeeded.

## Installation

Run interactive Pi inside tmux, with `tmux` available on `PATH` and
`TMUX_PANE` set by tmux. Tested with Pi 1.0.3. The package declares Node.js
22.19 or newer; Pi supplies the runtime dependencies, with no build step.

```sh
pi install git:github.com/leocavalcante/pi-tmux
```

Run `/reload` in Pi after installation. If you previously used the local
`tmux-title` extension, remove that copy before loading this package to avoid
running two naming requests for each prompt.

To update an existing installation:

```sh
pi update git:github.com/leocavalcante/pi-tmux
```

Run `/reload` afterward.

### Naming model

The naming model is `openai-codex/gpt-6-luna`, using your existing Pi
credentials. Authenticate with `/login` and make sure that model is available.
This does not change the model used for your main conversation.

There are no extension commands, settings, or environment overrides for the
naming model. To use another model, change `PROVIDER` and `MODEL` in `index.ts`
and load that local checkout instead of the installed package.

## Behavior

- Each non-empty interactive prompt requests a title using recent dialogue
  from the active session branch plus the new prompt.
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
- The marker clears on new input, another run, session replacement, reload,
  and graceful shutdown. Marker updates alone make no additional model calls
  and still work if the naming model is unavailable.
- The extension targets the window and session containing Pi's `TMUX_PANE`,
  even if you have switched focus elsewhere.
- Session markers aggregate waiting Pi panes across all windows. A busy or
  exiting pane does not clear the marker while another pane is waiting.
  Session names are not summarized, lowercased, or clipped.
- Changed naming context cancels the previous request. Session changes, tree
  navigation, reload, and shutdown cancel outstanding work too.
- Naming requests use SSE, with reasoning, retries, and cache retention
  disabled. Requests have a 15-second timeout and a 96-token output cap.
- Print, JSON, and RPC modes do not update tmux names or markers.
  Extension-injected input does not directly request a title; later refreshes
  can include resulting dialogue.
- Naming failures keep the existing task name; waiting status can still
  update. At most one warning appears per extension load. Identical context
  is not retried automatically after a failed naming request.

### Shared panes and cleanup

Multiple interactive Pi panes in one tmux window share its name and marker.
The last title or status update wins; the marker does not aggregate whether
other Pi panes in that window are busy.

Renaming turns off tmux's automatic process-based naming for that window.
Quitting Pi gracefully resets the name to `zsh`, regardless of your actual
shell, and does not re-enable automatic naming. `/reload` and Pi session
replacement clear that pane's waiting status, then refresh the task name from
the active history. The existing task name stays until a naming request succeeds.
A forced kill cannot run cleanup and may leave the task name and waiting
marker behind.
Moving or closing a pane does not immediately refresh its former session's
marker; the next status update from Pi in that session refreshes it. To restore
automatic process-based names instead:

```sh
tmux set-window-option -t <window-id> automatic-rename on
```

## Privacy and security

The naming model receives up to 6,000 characters of task context:

- The first 2,000 characters of your new prompt, when present.
- Up to eight recent user, assistant, or branch-summary text entries, each
  capped at 1,000 characters. Older entries are omitted to fit the total cap.
- The latest active compaction summary, capped at 1,000 characters.

Images, thinking blocks, tool calls, tool results, shell output, system prompts,
and custom extension messages are excluded. Summaries and ordinary dialogue
can still mention details from tool output. Provider billing, subscription
limits, and data handling apply to these additional requests. A run can request
a title on input and again at settlement when its context changes.

The model is instructed not to include secrets or personal information in
titles, but this is not a redaction guarantee. Do not put secrets into prompts.
Window names are visible in your tmux status bar and may be retained by tmux
session-persistence plugins.

This extension does not write prompts, responses, or credentials to files,
and it does not print provider error payloads. Authentication is resolved by
Pi. tmux runs with argument arrays, not interpolated shell commands; generated
names cannot become shell commands or tmux format expressions.

Like other Pi extensions, it runs with the same OS permissions as Pi. This
repository contains source and synthetic tests only. Keep credentials,
sessions, model caches, environment files, and personal Pi configuration out
of contributions. `.gitignore` is a precaution, not a substitute for reviewing
the staged diff and scanning for secrets.

## Development

```sh
git clone https://github.com/leocavalcante/pi-tmux.git
cd pi-tmux
bun test
```

- `index.ts` contains the extension, title formatting, context selection, and
  tmux status updates.
- `tests/title.test.ts` covers formatting, context bounds and exclusions,
  naming cancellation, lifecycle events, waiting markers, and failures with
  mock model responses and tmux commands.
- `tests/session.test.ts` checks session-marker aggregation across windows and
  panes against a separate temporary tmux server with no user configuration.
  It skips if tmux is unavailable.

The tests make no model API calls and do not rename your windows or sessions.

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

## License

[MIT](LICENSE).
