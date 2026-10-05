# pi-tmux

Name your tmux window from your latest [Pi](https://pi.dev) prompt with a short,
lowercase AI summary.

For example, a prompt about fixing failing authentication tests might become
`fix auth tests`. Names are capped at 24 ASCII characters so they stay compact
in the tmux status bar. Naming runs in the background and never waits before
Pi starts answering. When Pi finishes its work and waits for input, the title
gets a `* ` prefix, for example `* fix auth tests`. The prefix disappears on
your next prompt or when Pi starts another run. When you quit Pi normally,
the window name resets to `zsh`.

## Installation

Requires tmux and Pi. Tested with Pi 1.0.3. Pi supplies the runtime dependencies;
there is no build step.

```sh
pi install git:github.com/leocavalcante/pi-tmux
```

Run `/reload` in Pi after installation. If you previously used the local
`tmux-title` extension, remove that copy before loading this package to avoid
running two naming requests for each prompt.

The naming model is `openai-codex/gpt-6-luna`, using your existing Pi
credentials. Authenticate with `/login` and make sure that model is available.
This does not change the model used for your main conversation. To use a
different provider or model, change `PROVIDER` and `MODEL` in `index.ts` in a
local checkout.

## Behavior

- Each non-empty interactive prompt starts a naming request.
- Titles are forced to lowercase and clipped at a word boundary when possible.
- `* ` marks a fully settled run, after tool work, retries, and queued
  continuations are finished. It does not mean the task succeeded.
- The 24-character limit includes the marker. Waiting titles reserve two
  characters for `* `, leaving up to 22 for the task name.
- The marker clears on new input, another run, session replacement, reload,
  and graceful shutdown. Status updates make no additional model calls and
  still work if the naming model is unavailable.
- The extension targets the window containing Pi's `TMUX_PANE`, even if you
  have switched focus to another window.
- New input cancels the previous naming request. Session changes, reload, and
  shutdown cancel outstanding work too.
- Reasoning and retries are disabled. Naming requests have a 15-second timeout
  and a 96-token output cap.
- Print mode, RPC, and extension-injected messages do not rename windows.
- Naming failures keep the existing task name; waiting status can still
  update. At most one warning appears per extension load.

Multiple interactive Pi panes in one tmux window share its name and marker.
The last title or status update wins; the marker does not aggregate whether
other Pi panes in that window are busy.

Renaming turns off tmux's automatic process-based naming for that window.
Graceful shutdown resets the name to `zsh`, including during reload. A forced
kill cannot run cleanup and may leave the task name behind. To restore
automatic process-based names instead:

```sh
tmux set-window-option -t <window-id> automatic-rename on
```

## Privacy and security

The naming model receives the first 2,000 characters of your new prompt. It
does not receive conversation history, images, or tool results. Provider
billing, subscription limits, and data handling apply to these additional
requests.

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

The tests use mock model responses and tmux commands. They make no API calls
and do not rename real windows.

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
