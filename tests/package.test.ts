import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const manifestUrl = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));

test("the published Pi entrypoint is included and imports without runtime SDK dependencies", async () => {
	const [entrypoint] = manifest.pi.extensions as string[];
	expect(entrypoint).toBe("./index.ts");
	expect(manifest.files).toContain(entrypoint.replace(/^\.\//, ""));

	const source = readFileSync(new URL(entrypoint, manifestUrl), "utf8");
	const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-package-"));
	const modulePath = join(directory, "index.mjs");
	try {
		writeFileSync(modulePath, javascript);
		const extension = await import(pathToFileURL(modulePath).href);
		expect(typeof extension.default).toBe("function");
		expect(extension.MAX_TITLE_LENGTH).toBe(24);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
