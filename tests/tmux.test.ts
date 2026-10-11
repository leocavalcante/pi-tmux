import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { runTmux } from "../src/tmux.ts";
import { childHasExited, observeRejection, waitForChild, withFakeTmux as withFakeTmuxFixture } from "./tmux-test-utils.ts";

async function withFakeTmux(
	script: (files: { pid: string; cleanExit: string }) => string[],
	action: (files: { pid: string; cleanExit: string }) => Promise<void>,
) {
	const nodeExecutable = Bun.which("node");
	if (!nodeExecutable) throw new Error("Node.js is required for the fake tmux executable");
	await withFakeTmuxFixture(nodeExecutable, script, action);
}

test("runTmux does not spawn a child for a pre-aborted signal", async () => {
	await withFakeTmux(() => [], async ({ pid }) => {
		const controller = new AbortController();
		const reason = new Error("cancelled");
		controller.abort(reason);
		await expect(runTmux([], controller.signal)).rejects.toMatchObject({
			name: "AbortError",
			code: "ABORT_ERR",
			cause: reason,
		});
		expect(existsSync(pid)).toBe(false);
	});
});

test("runTmux rejects and reaps a child that exceeds its output bound", async () => {
	await withFakeTmux(() => [
		"process.stdout.write('x'.repeat(70 * 1024));",
		"setInterval(() => {}, 1000);",
	], async ({ pid }) => {
		const command = runTmux([], new AbortController().signal).then(
			() => undefined,
			(error: unknown) => error,
		);
		const childPid = await waitForChild(pid);
		const error = await command;
		expect(error).toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
		expect(await childHasExited(childPid)).toBe(true);
	});
});

test.skipIf(process.platform === "win32")(
	"runTmux rejects a timed-out child that exits cleanly after SIGTERM",
	async () => {
		await withFakeTmux(({ cleanExit }) => [
			"process.on('SIGTERM', () => setTimeout(() => {",
			`require("node:fs").writeFileSync(${JSON.stringify(cleanExit)}, "clean");`,
			"process.exit(0);",
			"}, 100));",
			"setInterval(() => {}, 1000);",
		], async ({ pid, cleanExit }) => {
			const command = runTmux([], new AbortController().signal);
			const rejected = observeRejection(command);
			const childPid = await waitForChild(pid);
			expect(await rejected).toBe(true);
			expect(await childHasExited(childPid)).toBe(true);
			expect(readFileSync(cleanExit, "utf8")).toBe("clean");
		});
	},
);

test("runTmux reaps a child on cancellation", async () => {
	await withFakeTmux(() => [
		"process.on('SIGTERM', () => {});",
		"setInterval(() => {}, 1000);",
	], async ({ pid }) => {
		const controller = new AbortController();
		const command = runTmux([], controller.signal);
		const rejected = observeRejection(command);
		const childPid = await waitForChild(pid);
		controller.abort();
		expect(await rejected).toBe(true);
		expect(await childHasExited(childPid)).toBe(true);
	});
});
