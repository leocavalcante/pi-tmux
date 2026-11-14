# Standardization plan: pi-tmux

Status: done except gallery media, 2026-11-14. Target: [Pi extension standard v1](pi-extension-standard.md). Delete this file once every step is done.

pi-tmux becomes the reference implementation. New extensions copy their shared files from this repository (standard §15), so these steps produce the canonical versions of those files.

## Progress

- Step 0 is complete: identity, topics, website, merge settings, security features, labels, the `npm` environment, and `sha_pinning_required`. Tag `v0.1.0` and its release record that 0.1.0 was published by hand; its tarball matches commit `8749aea`.
- Step 1 merged as #1000 with the ruleset cutover; CodeQL default setup replaced `codeql.yml`. `engines.pi` declares the minimum Pi for the shared `pi-min` job, and `.github/scripts/setup-test-tools.sh` installs tmux.
- Step 2 merged as #1001. Its first CD runs failed in `verifyConditions` until the trusted publisher moved from `publish.yml` to `cd.yaml`; nothing was tagged or published in the meantime.
- Step 3 merged as #1003 and released **0.1.8**, the first automated release, with provenance.
- Steps 4–6 and 8 merged as #1004 (Prettier), #1007 (`.git-blame-ignore-revs`), and #1008 (typescript-eslint plus `noUncheckedIndexedAccess`). Review caught an early draft that made the naming screen throw on unchecked reads; the merged version keeps the exact runtime reads.
- Step 7 merged as #1009 and released **0.1.9**.
- Also merged: #1005 (shared-file sync) and #1006 (Pi 1.5.2 for development, replacing Dependabot's #1002).
- npm: the trusted publisher is `cd.yaml` with environment `npm`, `0.0.0-stage` is deprecated, and publishing requires 2FA and disallows tokens.
- **Remaining:** add `pi.image` and upload the matching social preview by hand. Then delete this file.

## Target identity

| Field                   | Value                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Description             | Name tmux windows after your current Pi task and mark the ones waiting for your input.                                |
| Topics and npm keywords | `pi-extension` `pi-package` `pi-coding-agent` `tmux` `terminal` `terminal-multiplexer` `notifications` `productivity` |
| Website                 | https://pi.dev/packages/@leocavalcante/pi-tmux                                                                        |
| Kind                    | Extension                                                                                                             |
| Pi versions             | Minimum 1.1.0; tested with 1.5.2                                                                                      |

## Where it stands

- **Bun already runs the tests.** `bun test` passes 762 and skips 3, and `tests/tmux-node.mjs` already runs the subprocess cases on Node.js. Installs still use npm (`package-lock.json`), and TypeScript is 7.0.2, which typescript-eslint doesn't support yet.
- **CI and publishing are mature.**
  - CI covers Node.js 22.19.0, 24, and 26, with gitleaks, npm audit, and publint, plus Pi 1.1.0, tmux 3.4, a pinned tmux 3.7c source build, macOS, and Windows.
  - CodeQL covers `actions` and JavaScript/TypeScript.
  - Dependabot runs without Conventional Commit prefixes, and publishing is triggered by GitHub releases.
- **Classic branch protection** requires the checks `test (22)` and `test (24)`.
- **npm and tags.** npm 0.1.7 has provenance. Tags cover v0.1.1–v0.1.7. 0.1.0 has no tag; npm recorded commit `8749aea`. Nothing releasable has landed since v0.1.7.
- **`package.json`.** The `@earendil-works/pi-coding-agent` peer is `^1.1.0`; the standard requires `*`. The entry point is `./index.ts` at the root.
- **Formatting.** About 10,800 lines are indented with tabs, so moving to Prettier's 2 spaces is the largest reformat of the four repositories.
- **README.** At 669 lines, it's already the closest to the target voice. Its "Publishing" section is maintainer history.
- **Tests that check repository files.** `tests/workflows.test.ts` checks CI details: pinned actions, README versions that match CI, the minimum Pi in CI, and the Node.js version on Windows. `tests/issue-templates.test.ts` checks the issue forms.
- **Measured:** TypeScript 6.0.3 reports no errors; `noUncheckedIndexedAccess` adds 35.

## Steps

Each step is one pull request unless marked otherwise. "Release" is what `cd.yaml` publishes after the merge.

| #   | Change                                                                | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Release   |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 0   | _Settings_                                                            | Standard A.11 except rulesets. Replace the topics. Optionally tag `v0.1.0` at `8749aea`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —         |
| 1   | `build: adopt the Bun and TypeScript 6 toolchain with CI`             | <ul><li>`bun.lock` replaces `package-lock.json`.</li><li>TypeScript 7.0.2 becomes 6.0.3, and `tsconfig.test.json` becomes `tests/tsconfig.json`.</li><li>`tests/tmux-node.mjs` becomes `tests/tmux.node-test.ts`, and `tests/load.node-test.ts` is added. jiti is already installed.</li><li>`ci.yaml` gets the shared jobs plus tmux jobs: tmux 3.4 from apt, the tmux 3.7c source build, and Homebrew tmux on macOS. `pi-min` is 1.1.0.</li><li>Add `pr-title.yaml`, and switch Dependabot to the `bun` ecosystem with prefixes.</li><li>Delete `test.yml` and `codeql.yml`, and update `tests/workflows.test.ts`.</li><li>Merge using the cutover checklist.</li></ul> | none      |
| 2   | `ci: release to npm automatically from main`                          | <ul><li>Add `cd.yaml`, `.releaserc.json`, and `cliff.toml`.</li><li>Set the version to `0.0.0-development`, and add `CHANGELOG.md` to `files` and `.gitignore`.</li><li>Delete `publish.yml`, and move the trusted publisher from `publish.yml` to `cd.yaml`.</li></ul>                                                                                                                                                                                                                                                                                                                                                                                                   | none      |
| 3   | `fix: declare Pi host packages as wildcard peer dependencies`         | Change `^1.1.0` to `*`. The README and the `pi-min` job keep the minimum at 1.1.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **0.1.8** |
| 4   | `style: format with Prettier`                                         | Tabs become 2 spaces. Formatting changes only. CI starts running `prettier --check`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | none      |
| 5   | `chore: ignore the formatting commit in git blame`                    | `.git-blame-ignore-revs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | none      |
| 6   | `chore: lint with typescript-eslint`                                  | Add `eslint.config.mjs` and apply the fixes that don't change behavior. Each real bug ESLint finds gets its own `fix:` PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | none      |
| 7   | `docs(readme): adopt the shared structure and voice`                  | <ul><li>Move "Publishing" to CONTRIBUTING.</li><li>Use the new tagline and the Compatibility template.</li><li>Generalize the issue forms (keeping the tmux version field) and update `tests/issue-templates.test.ts`.</li><li>Add AGENTS.md, the PR template, CODEOWNERS, and the standard.</li><li>Update the `package.json` metadata.</li></ul>                                                                                                                                                                                                                                                                                                                        | patch     |
| 8   | `refactor: check indexed access`                                      | Turn on `noUncheckedIndexedAccess` and fix the 35 sites.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | none      |
| 9   | `refactor: move the extension entry into src/`                        | `pi.extensions` points to `./src/extension.ts`. The root `index.ts` re-exports it for one release.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | none      |
| 10  | _Optional_ `feat: add /tmux-quit-pane as the namespaced quit command` | Keep `/quit-pane` as an alias (standard §13).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | minor     |
| 11  | _After the releases_                                                  | Deprecate `0.0.0-stage`. Add `pi.image`, a screenshot of named and waiting windows, and the social preview. Turn on `sha_pinning_required`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —         |

## Cutover checklist

**Branch protection (step 1).** Classic protection requires check names that the new CI no longer reports, and the rule applies to admins.

- [ ] Open step 1's PR and wait for `required` and `pr-title` to pass.
- [ ] Create the `main` and `v*` rulesets (standard A.10).
- [ ] Delete classic protection: `gh api -X DELETE repos/leocavalcante/pi-tmux/branches/main/protection`.
- [ ] Merge step 1, then turn on CodeQL default setup. Step 1 deleted `codeql.yml`.

**Publishing (step 2):**

- [ ] Run `npm login`, then `npm trust list @leocavalcante/pi-tmux`. It currently points to `publish.yml`.
- [ ] Run `npm trust github @leocavalcante/pi-tmux --file cd.yaml --repo leocavalcante/pi-tmux --env npm --allow-publish`, and revoke the `publish.yml` entry.
- [ ] Create the `npm` environment, with `main` as its only deployment branch.
- [ ] Merge step 2. Nothing is released, because there are no releasable commits since `v0.1.7`.
- [ ] Merge step 3, then check:
  - [ ] Tag `v0.1.8` exists.
  - [ ] npm 0.1.8 has provenance.
  - [ ] The GitHub release has notes.
  - [ ] The tarball contains `CHANGELOG.md`.
  - [ ] `pi update` shows "Extension Updates".

## Notes and risks

- **Reformatting.** Tabs to spaces touches almost every line. Merge open PRs before step 4, or rebase them with `prettier --write` afterwards.
- **Node.js lane.** The tmux subprocess tests stay on Node.js because Pi runs the extension there. `tests/tmux-test-utils.ts` imports only `node:*` modules, and both lanes already share it.
- **README checks.** `tests/workflows.test.ts` checks that the README matches CI. Keep checks that verify facts users rely on, such as the tested tmux and Pi versions. Drop the ones the standard's CI hygiene already covers, such as action pinning, which zizmor and the repository setting enforce.
- **Commands.** `/tmux-title` already follows §13. `/quit-pane` predates the convention; renaming it without an alias would be a breaking change.

## Rollout across the extensions

This section is identical in every repository's plan.

**Order:**

1. Retire pi-ttyd.
2. pi-otel, the pilot, which also ships its missing fix.
3. pi-a2a.
4. pi-tmux, which becomes the reference implementation.
5. pi-subagents, which has the largest test migration.

Finish a repository's steps 1–3 before starting the next one, so each migration builds on the last.

**npm account (once, interactive):**

1. Run `npm login`, then `npm trust list <package>` for each package to record today's trusted publishers.
2. At each repository's step 2, run `npm trust github <package> --file cd.yaml --repo leocavalcante/<repo> --env npm --allow-publish`. This replaces any `publish.yml` entry.
3. Set each package's publishing access to "require 2FA and disallow tokens".
4. Run `npm deprecate <package>@0.0.0-stage "Bootstrap placeholder; not a release."`

**Retire pi-ttyd.** It has no open issues or pull requests, and about 17 downloads a week.

1. Merge `docs: mark pi-ttyd as unmaintained`. The README opens with: "**pi-ttyd is no longer maintained.** Published versions stay installable, but they won't get updates or security fixes. Remove it with `pi remove npm:pi-ttyd`."
2. Run `npm deprecate pi-ttyd "pi-ttyd is no longer maintained. Remove it with: pi remove npm:pi-ttyd"`.
3. Run `gh repo edit leocavalcante/pi-ttyd --description "Unmaintained. Set ttyd tab titles, notify you when Pi is ready, and accept dropped images."`.
4. Run `gh repo archive leocavalcante/pi-ttyd --yes`.
