# Contributing

## Setup

Development uses Node.js 22.19 or newer and npm for dependencies and checks; tests run on Bun 1.4.2. `npm test` delegates to `bun test` and does not fall back to Node's test runner. Install Bun using the [Bun installation guide](https://bun.sh/docs/installation).

```sh
git clone https://github.com/leocavalcante/pi-tmux.git
cd pi-tmux
npm ci --ignore-scripts
```

To try the checkout in Pi without changing your settings:

```sh
pi --extension ./index.ts
```

Use either the installed package or the development extension, not both.

## Checks

Run the extension and test TypeScript checks:

```sh
npm run check
npm run check:tests
```

`index.ts` contains the extension, title formatting, context selection, and tmux status updates. The window snapshot is tab-delimited and its last field can be empty; preserve its trailing tab and remove only tmux's line terminator. Injected `RunTmux` adapters retain flat command arrays by default; adapters that support the server-PID guard can opt in with `supportsServerPidGuard = true`.

## Tests

Run the test suite:

```sh
npm test
```

- `npm run check:tests` type-checks every file under `tests/` with strict settings and Bun/Node types; CI runs this check.
- `tests/title.test.ts` covers formatting, context bounds and exclusions, naming cancellation, model configuration, empty window-name fields, status-only mode, explicit retries, manual pins, read-only diagnostics, model-free sync, truthful confirmations, lifecycle events, waiting markers, and failures with mock model responses and tmux commands.
- `tests/session.test.ts` checks window and session aggregation, shared-window ownership, concurrent status and ownership changes at rename time, and pane moves against a separate temporary tmux server with no user configuration. Its command wrapper strips only the final line ending so trailing spaces in literal tmux names remain observable in assertions. It skips if tmux is unavailable.
- `tests/move.test.ts` checks former-location marker repair, remaining peers, custom names, vanished targets, repeated moves, explicit sync retries, superseded repairs, and a server restart between lookup and write with reused numeric IDs on isolated tmux servers. Those checks skip if tmux is unavailable; the queue and stabilization bounds also have a mock-only regression.
- `tests/status.test.ts` verifies read-only diagnostic snapshots and waiting-flag aggregation on an isolated tmux server. It skips if tmux is unavailable.
- `tests/package.test.ts` runs `npm pack` in a temporary directory, inspects the packed manifest and entrypoint, then imports the extracted file after Bun's TypeScript erasure and exercises status-only lifecycle behavior without a runtime SDK dependency. It requires `npm` and `tar` on `PATH`; on Windows the npm command shim is launched through the command shell.

Tmux integration tests use separate temporary servers and skip automatically when `tmux` is unavailable; install tmux to run that integration coverage. The fixtures use Unix paths (`/dev/null` and `/bin/sleep`), so run them on a Unix-like host such as Linux, macOS, or WSL. Mock-only tests, including empty window-name parsing, do not need tmux. GitHub Actions runs the type check, tests, and package-content check on Linux with Node.js 22 and 24 and Bun 1.4.2. Tests make no model API calls and do not rename your windows or sessions.

## Before submitting

Keep credentials, sessions, model caches, environment files, and personal Pi configuration out of contributions. `.gitignore` is a precaution, not a substitute for reviewing the staged diff and scanning for secrets.

Review the staged files and scan with [Gitleaks](https://github.com/gitleaks/gitleaks):

```sh
git diff --cached --check
gitleaks dir . --redact
gitleaks git . --redact
```
