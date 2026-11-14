# AGENTS.md

pi-tmux: name tmux windows after the current Pi task and mark the ones waiting for input.

## Layout

- `index.ts` is the extension entrypoint and re-exports public title, naming, and tmux helpers.
- `src/extension.ts` registers `/tmux-title`, `/quit-pane`, and Pi lifecycle handlers.
- `src/controller.ts` manages model requests, title state, waiting markers, shared panes, and location repair.
- `src/naming.ts` builds bounded context, screens sensitive text, and requests task titles.
- `src/title.ts` sanitizes and formats titles; `src/tmux.ts` owns tmux formats, subprocesses, and guarded writes.
- `src/notify.ts` and `src/unicode-digits.ts` provide safe notifications and Unicode digit checks.
- `tests/*.test.ts` is the Bun lane. `tests/*.node-test.ts` is the Node.js lane.

## Commands

- `bun install --frozen-lockfile` installs dependencies.
- `bun run lint` checks formatting and lint rules; `bun run check` type-checks source, tests, and CI scripts.
- `bun run test` runs both test lanes. Use `bun run test:bun` or `bun run test:node` for one lane.
- `bun run check:package` validates package contents; `bun run verify` runs the complete local verification sequence.
- `pi -e ./index.ts` loads this checkout in Pi.

## Rules

- Follow `docs/pi-extension-standard.md` and keep user-facing documentation in its §10 voice.
- Write Conventional Commits. PR titles are user-facing release notes, imperative and lowercase, at most 72 characters, with no final period.
- Sign off every commit with `git commit -s`. Never add a `Co-Authored-By` trailer.
- Never bump the version, edit the generated changelog, create tags or releases, or publish. The CD workflow does that.
- Code in `src/` runs on Node.js inside Pi. Use `node:*` APIs, never Bun APIs.
- Keep Pi host packages in `peerDependencies` with version `"*"`, never in `dependencies`.
- Tests use synthetic data and fakes; they must not make network or paid model calls.
- Update `README.md` and `CONTRIBUTING.md` with behavior changes.

## Security boundaries

- Preserve lowercase ASCII title sanitization and the 24-character limit, including the waiting prefix. Do not interpolate title text into shell commands, tmux command syntax, options, or formats; prevent shell, tmux, and format injection.
- Bound naming context and screen recognizable credentials and labeled personal information before model-registry lookup or provider access. Screen model output and manual titles before applying them. These checks are best-effort, not comprehensive redaction.
- Keep tmux command output capped at 64 KiB, with a 2-second timeout and a 500 ms kill grace; terminate and reap children after cancellation or timeout.
- Preserve the server-PID guard on write batches so a restarted tmux server cannot receive stale numeric targets.
- Aggregate waiting markers from pane flags on the tmux server. A busy or exiting pane must not clear another pane's window or session marker.
- Keep Pi host packages as `"*"` peers and preserve the extension's use of the Pi runtime that loads it.
