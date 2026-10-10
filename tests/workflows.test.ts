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
