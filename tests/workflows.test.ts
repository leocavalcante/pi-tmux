import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKFLOWS_DIRECTORY = fileURLToPath(new URL("../.github/workflows/", import.meta.url));

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
