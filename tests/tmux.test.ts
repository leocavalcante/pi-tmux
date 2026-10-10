import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runTmux } from "../src/tmux.ts";

test.skipIf(process.platform === "win32")("runTmux rejects a timed-out child that exits cleanly after SIGTERM", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-timeout-"));
	const executable = join(directory, "tmux");
	const started = join(directory, "started");
	const originalPath = process.env.PATH;
	try {
		writeFileSync(executable, [
			"#!/usr/bin/env node",
			`require("node:fs").writeFileSync(${JSON.stringify(started)}, "started");`,
			"process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));",
			"setInterval(() => {}, 1000);",
			"",
		].join("\n"));
		chmodSync(executable, 0o755);
		process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
		await expect(runTmux([], new AbortController().signal)).rejects.toThrow();
		expect(readFileSync(started, "utf8")).toBe("started");
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(directory, { recursive: true, force: true });
	}
});
