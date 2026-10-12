import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { cleanupTmuxFixture, supportsUnixTmux } from "./tmux-support.ts";

const WORKFLOWS_DIRECTORY = fileURLToPath(new URL("../.github/workflows/", import.meta.url));

test("tmux integration fixtures require a Unix-like platform and a tmux executable", () => {
	expect(supportsUnixTmux("win32", "C:\\tools\\tmux.exe")).toBe(false);
	expect(supportsUnixTmux("linux", "/usr/bin/tmux")).toBe(true);
	expect(supportsUnixTmux("darwin", null)).toBe(false);
});

test("tmux fixture cleanup does not mask a test failure", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-cleanup-test-"));
	const failure = new Error("fixture failed");
	let observed: unknown;
	try {
		try {
			throw failure;
		} finally {
			cleanupTmuxFixture(() => { throw new Error("server already exited"); }, directory);
		}
	} catch (error) {
		observed = error;
	}
	expect(observed).toBe(failure);
	expect(existsSync(directory)).toBe(false);

	observed = undefined;
	try {
		try {
			throw failure;
		} finally {
			cleanupTmuxFixture(() => {}, "\0");
		}
	} catch (error) {
		observed = error;
	}
	expect(observed).toBe(failure);
});

test("README table of contents links resolve to section headings", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
	const contents = /^## Contents\n([\s\S]*?)(?=^## )/m.exec(readme)?.[1];
	if (!contents) throw new Error("README must include a Contents section before its main sections");

	const occurrences = new Map<string, number>();
	const headingAnchors = new Set([...readme.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map(([, heading]) => {
		const slug = heading!.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "")
			.trim().replace(/\s+/gu, "-").replace(/-+/gu, "-");
		const occurrence = occurrences.get(slug) ?? 0;
		occurrences.set(slug, occurrence + 1);
		return occurrence === 0 ? slug : `${slug}-${occurrence}`;
	}));
	const anchors = [...contents.matchAll(/\]\(#([^)]*)\)/gu)].map(([, anchor]) => anchor!);
	expect(anchors.length).toBeGreaterThan(0);
	expect(anchors.filter((anchor) => !headingAnchors.has(anchor))).toEqual([]);
});

test("README tmux compatibility versions stay aligned with version-checked CI", () => {
	const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/test.yml", import.meta.url)), "utf8");
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
	expect(workflow).toContain('tmux -V | grep -Fx "tmux 3.4"');
	expect(workflow).toContain('test "$(tmux -V)" = "tmux 3.7c"');
	expect(readme).toMatch(/Linux CI exercises tmux 3\.4 and a pinned tmux 3\.7c\nbuild/u);
});

test("README documents the bounded manual and idle-title input limit", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\s+/gu, " ");
	expect(readme).toContain("values longer than 64 Ki UTF-16 code units");
	expect(readme).toContain("Inputs longer than 64 Ki UTF-16 code units are rejected before screening");
});

test("README cites J-LIS for the Japanese My Number checksum rule", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\s+/gu, " ");
	expect(readme).toContain("J-LIS check-digit rule (Japanese PDF)");
	expect(readme).toContain("https://www.j-lis.go.jp/data/open/cnt/3/1282/1/H2707_qa.pdf");
});

test("README cites INSEE for Corsican NIR check-key support", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\s+/gu, " ");
	expect(readme).toContain("Corsican `2A`/`2B` department codes");
	expect(readme).toContain("https://xml.insee.fr/schema/nir.html");
});

test("README cites the Ministry of the Interior for Spanish DNI/NIE checks", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\s+/gu, " ");
	expect(readme).toContain("Ministry of the Interior control-digit guide");
	expect(readme).toContain("https://www.interior.gob.es/opencms/en/servicios-al-ciudadano/tramites-y-gestiones/dni/calculo-del-digito-de-control-del-nif-nie/");
});

test("README cites the NHS Data Dictionary for NHS number validation", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\s+/gu, " ");
	expect(readme).toContain("10 digits and a valid Modulus 11 check digit");
	expect(readme).toContain("https://www.datadictionary.nhs.uk/attributes/nhs_number.html");
});

test("README cites Skatteverket for Swedish personal-number checks", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\s+/gu, " ");
	expect(readme).toContain("Skatteverket's Modulus 10 method");
	expect(readme).toContain("alternating weights 1 and 2");
	expect(readme).toContain("https://www4.skatteverket.se/rattsligvagledning/edition/2026.6/330245.html");
});

test("README cites the ATO for local TFN screening limitations", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\s+/gu, " ");
	expect(readme).toContain("local weighted Modulus 11 checksum pattern");
	expect(readme).toContain("best-effort screening and does not confirm ATO issuance");
	expect(readme).toContain("software developers may request its TFN validation algorithm");
	expect(readme).toContain("https://www.ato.gov.au/tax-and-super-professionals/for-superannuation-professionals/apra-regulated-funds/managing-member-benefits/taxation-of-member-super-benefits/tax-file-numbers-and-super-contributions/obtaining-member-tfns");
});

test("README cites Inland Revenue for the current New Zealand IRD range", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\s+/gu, " ");
	expect(readme).toContain("up to 200,000,000");
	expect(readme).toContain("2026 increase to the validation ceiling");
	expect(readme).toContain("https://www.ird.govt.nz/updates/news-folder/2026/increase-to-ird-number-validation-upper-limit");
});

test("CONTRIBUTING documents current privacy screening test coverage", () => {
	const contributorGuide = readFileSync(fileURLToPath(new URL("../CONTRIBUTING.md", import.meta.url)), "utf8")
		.replace(/\s+/gu, " ");
	expect(contributorGuide).toContain("explicitly labeled personal-data screening");
	expect(contributorGuide).toContain("Unicode variants, near-misses, and retained-context-boundary cases");
	expect(contributorGuide).toContain("context is screened before model-registry access without echoing matches");
	expect(contributorGuide).toContain("sensitive-looking context is not sent to the model");
	expect(contributorGuide).toContain("sensitive-looking output is neither applied nor disclosed");
	expect(contributorGuide).toContain("identifier examples are synthetic");
	expect(contributorGuide).toContain("runtime-supported decimal digit mappings");
	expect(contributorGuide).toContain("conservative handling of unmappable digits");
});

test("README distinguishes shared title updates from status-only markers", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\s+/gu, " ");
	expect(readme).toContain("Waiting-marker updates alone preserve the current shared title instead of replaying a stale per-pane title");
	expect(readme).toContain("a new AI result, manual pin, or explicit `/tmux-title sync` can replace it");
});

test("README specifies UTF-16 code-unit limits for naming context sent to the model", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\s+/gu, " ");
	expect(readme).toContain("up to 6,000 UTF-16 code units of task context");
	expect(readme).toContain("a supplementary Unicode character counts as two");
	expect(readme).toContain("Up to 2,000 UTF-16 code units from your new prompt");
	expect(readme).toContain("capped at 1,000 UTF-16 code units");
	expect(readme).toContain("truncation keeps such characters intact");
});

test("CI history secret scanning verifies its pinned binary and redacts findings", () => {
	type WorkflowStep = { name?: string; if?: string; env?: Record<string, string>; run?: string };
	const workflow = parseYaml(readFileSync(fileURLToPath(new URL("../.github/workflows/test.yml", import.meta.url)), "utf8")) as {
		jobs?: Record<string, { steps?: WorkflowStep[] }>;
	};
	const scan = workflow.jobs?.test?.steps?.find((step) => step.name === "Scan Git history for secrets");
	if (!scan) throw new Error("The Tests workflow must scan Git history for secrets");

	expect(scan.if).toBe("matrix.node == 22");
	expect(scan.env?.GITLEAKS_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
	expect(scan.env?.GITLEAKS_SHA256).toMatch(/^[a-f0-9]{64}$/u);
	const run = scan.run ?? "";
	expect(run).toContain('archive="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"');
	expect(run).toContain('url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}"');
	expect(run).toContain("curl --fail --location --silent --show-error");
	expect(run).toContain('"$GITLEAKS_SHA256" "$RUNNER_TEMP/$archive" | sha256sum --check --status');
	const checksum = run.indexOf("sha256sum --check --status");
	const extraction = run.indexOf("tar -xzf");
	const execution = run.indexOf('"$RUNNER_TEMP/gitleaks" git --redact --no-banner .');
	expect(checksum).toBeGreaterThanOrEqual(0);
	expect(extraction).toBeGreaterThan(checksum);
	expect(execution).toBeGreaterThan(extraction);
});

test("manual npm bootstrap checks out clean origin/main before logging in", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
	const commands = /Bootstrap version `0\.1\.0`[\s\S]*?```sh\n([\s\S]*?)\n```/u.exec(readme)?.[1];
	if (!commands) throw new Error("README must document the one-time npm bootstrap commands");
	const preflight = [
		"git fetch origin",
		'test "$(git branch --show-current)" = "main"',
		'test -z "$(git status --porcelain)"',
		'test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"',
	].map((command) => commands.indexOf(command));
	const login = commands.indexOf("npm login");
	expect(preflight.every((position, index) => position >= 0 && position < login
		&& (index === 0 || position > preflight[index - 1]!))).toBe(true);
});

test("npm publishing requires all release safety gates", () => {
	const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/publish.yml", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
	const topLevelPermissions = /^permissions:\n((?:  [^\n]*\n)+)/m.exec(workflow)?.[1] ?? "";
	const publishJob = workflow.indexOf("  publish:\n");
	const testDependency = workflow.indexOf("    needs: test", publishJob);
	const stableReleaseOnly = workflow.indexOf("    if: github.event.release.prerelease == false", publishJob);
	const publishPermissions = workflow.indexOf("    permissions:\n", publishJob);
	const publishTokenPermission = workflow.indexOf("      id-token: write", publishPermissions);
	const checkout = workflow.indexOf("fetch-depth: 0", publishJob);
	const ancestryCheck = workflow.indexOf('git merge-base --is-ancestor "$GITHUB_SHA" origin/main', publishJob);
	const versionCheck = workflow.indexOf("- name: Check release tag matches package version", publishJob);
	const releaseTagInput = workflow.indexOf("RELEASE_TAG: ${{ github.event.release.tag_name }}", versionCheck);
	const semanticVersionValidation = workflow.indexOf(String.raw`!/^\d+\.\d+\.\d+$/.test(version)`, versionCheck);
	const tagValidation = workflow.indexOf("process.env.RELEASE_TAG !== `v${version}`", versionCheck);
	const publish = workflow.indexOf("npm publish --access public", publishJob);

	expect(publishJob).toBeGreaterThanOrEqual(0);
	expect(topLevelPermissions).toContain("contents: read");
	expect(topLevelPermissions).not.toContain("id-token:");
	expect(testDependency).toBeGreaterThan(publishJob);
	expect(stableReleaseOnly).toBeGreaterThan(testDependency);
	expect(publishPermissions).toBeGreaterThan(stableReleaseOnly);
	expect(publishTokenPermission).toBeGreaterThan(publishPermissions);
	expect(publishTokenPermission).toBeLessThan(checkout);
	expect(checkout).toBeGreaterThan(publishTokenPermission);
	expect(ancestryCheck).toBeGreaterThan(checkout);
	expect(versionCheck).toBeGreaterThan(ancestryCheck);
	expect(releaseTagInput).toBeGreaterThan(versionCheck);
	expect(semanticVersionValidation).toBeGreaterThan(releaseTagInput);
	expect(tagValidation).toBeGreaterThan(semanticVersionValidation);
	expect(publish).toBeGreaterThan(tagValidation);
});

test("local verify script runs the same validation gates as CI", () => {
	const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
		scripts?: Record<string, string>;
	};
	expect(manifest.scripts?.verify).toBe([
		"npm run check",
		"npm run check:tests",
		"npm audit --audit-level=high",
		"npm test",
		"npm pack --dry-run --ignore-scripts",
	].join(" && "));
});

test("the package test command runs native Node subprocess coverage", () => {
	const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
		scripts?: Record<string, string>;
	};
	expect(manifest.scripts?.test).toBe("bun test tests/ && npm run test:node");
	expect(manifest.scripts?.["test:node"]).toBe("node --test tests/tmux-node.mjs");
});

test("@types/node stays pinned to 22.20.5 in the manifest and lockfile", () => {
	const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
		devDependencies?: Record<string, string>;
	};
	const lockfile = JSON.parse(readFileSync(fileURLToPath(new URL("../package-lock.json", import.meta.url)), "utf8")) as {
		packages?: Record<string, { devDependencies?: Record<string, string>; version?: string }>;
	};
	const pinnedVersion = "22.20.5";

	expect(manifest.devDependencies?.["@types/node"]).toBe(pinnedVersion);
	expect(lockfile.packages?.[""]?.devDependencies?.["@types/node"]).toBe(pinnedVersion);
	expect(lockfile.packages?.["node_modules/@types/node"]?.version).toBe(pinnedVersion);
});

test("external GitHub Actions use full commit SHAs with version comments", () => {
	const workflowFiles = readdirSync(WORKFLOWS_DIRECTORY)
		.filter((file) => /\.ya?ml$/i.test(file))
		.sort();
	let checkedActions = 0;

	for (const file of workflowFiles) {
		const contents = readFileSync(fileURLToPath(new URL(`../.github/workflows/${file}`, import.meta.url)), "utf8");
		const lines = contents.split(/\r?\n/);
		for (const [index, line] of lines.entries()) {
			const match = /^\s*uses:\s*([^\s#]+)(?:\s+#\s*(.*))?\s*$/.exec(line);
			if (!match) continue;
			const [, reference, versionComment] = match;
			if (reference.startsWith("./")) continue;
			checkedActions++;
			if (!/^[^@]+@[0-9a-f]{40}$/.test(reference)) {
				throw new Error(`${file}:${index + 1}: pin external action to a full commit SHA: ${reference}`);
			}
			if (!versionComment?.startsWith("v")) {
				throw new Error(`${file}:${index + 1}: retain a version comment for Dependabot: ${reference}`);
			}
		}
	}

	expect(checkedActions).toBeGreaterThan(0);
});
