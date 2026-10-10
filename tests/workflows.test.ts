import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKFLOWS_DIRECTORY = fileURLToPath(new URL("../.github/workflows/", import.meta.url));

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
