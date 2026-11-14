# AGENTS.md

pi-tmux: name tmux windows after your current Pi task and mark the ones waiting for your input.

## Commands

- `bun install --frozen-lockfile` installs dependencies.
- `bun run verify` runs every check CI runs.
- `bun run test:bun` and `bun run test:node` run one test lane.
- `bun run format` applies Prettier and ESLint fixes.
- `pi -e ./src/extension.ts` tries the checkout in Pi.

## Rules

- Follow docs/pi-extension-standard.md.
- Write Conventional Commits. The PR title becomes the release note (standard §10, rule 11).
- Sign off every commit (`git commit -s`). Never add Co-Authored-By.
- Never bump the version, edit CHANGELOG.md, create tags or releases, or publish. cd.yaml does that.
- Code in src/ runs on Node.js inside Pi: use `node:*` APIs, never Bun APIs.
- Keep Pi host packages, such as `@earendil-works/pi-coding-agent` and `typebox`, as `"*"` peer dependencies, never dependencies.
- Tests make no network or paid model calls.
- Update README.md and CONTRIBUTING.md with every behavior change, in the voice from standard §10.

## Project notes

### Layout

- `src/extension.ts` is the Pi entry point, named by `package.json` `pi.extensions`. The root `index.ts` re-exports it with the title, naming, and tmux helpers that tests use.
- `src/extension.ts` registers `/tmux-title`, `/quit-pane`, and Pi lifecycle handlers.
- `src/controller.ts` manages model requests, title state, waiting markers, shared panes, and location repair.
- `src/naming.ts` builds bounded context, screens sensitive text, and requests task titles.
- `src/title.ts` sanitizes and formats titles; `src/tmux.ts` owns tmux formats, subprocesses, and guarded writes.
- `src/notify.ts` and `src/unicode-digits.ts` provide safe notifications and Unicode digit checks.
- `tests/*.test.ts` is the Bun lane. `tests/*.node-test.ts` is the Node.js lane.

### Boundaries to preserve

- Preserve lowercase ASCII title sanitization and the 24-character limit, including the waiting prefix. Do not interpolate title text into shell commands, tmux command syntax, options, or formats; prevent shell, tmux, and format injection.
- Bound naming context and screen recognizable credentials and labeled personal information before model-registry lookup or provider access. Screen model output and manual titles before applying them. These checks are best-effort, not comprehensive redaction.
- Keep tmux command output capped at 64 KiB, with a 2-second timeout and a 500 ms kill grace; terminate and reap children after cancellation or timeout.
- Preserve the server-PID guard on write batches so a restarted tmux server cannot receive stale numeric targets.
- Aggregate waiting markers from pane flags on the tmux server. A busy or exiting pane must not clear another pane's window or session marker.
- Keep Pi host packages as `"*"` peers and preserve the extension's use of the Pi runtime that loads it.
