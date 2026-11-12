import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { runTmux } from "../src/tmux.ts";
import {
	childHasExited,
	type FakeTmuxFiles,
	observeRejection,
	waitForChild,
	withFakeTmux,
} from "./tmux-test-utils.ts";

// Pi runs the extension on Node.js, so these subprocess cases run on Node's
// native child_process implementation, not Bun's.
function withNativeFakeTmux(
	script: (files: FakeTmuxFiles) => string[],
	action: (files: FakeTmuxFiles) => Promise<void>,
): Promise<void> {
	return withFakeTmux(process.execPath, script, action);
}

interface NodeError extends Error {
	code?: string;
	cause?: unknown;
}

test("Node-native tmux subprocess behavior", async (suite) => {
	// The fixtures temporarily change PATH and NODE_OPTIONS, so run each one serially.
	await suite.test("does not spawn a child for a pre-aborted signal", async () => {
		await withNativeFakeTmux(() => [], async ({ pid }) => {
			const controller = new AbortController();
			const reason = new Error("cancelled");
			controller.abort(reason);
			await assert.rejects(runTmux([], controller.signal), (error: NodeError) => {
				assert.equal(error.name, "AbortError");
				assert.equal(error.code, "ABORT_ERR");
				assert.equal(error.cause, reason);
				return true;
			});
			assert.equal(existsSync(pid), false);
		});
	});

	await suite.test("preserves trailing carriage returns while removing the output line feed", async () => {
		await withNativeFakeTmux(() => [
			"process.stdout.write('custom name\\r\\n', () => process.exit(0));",
		], async () => {
			assert.equal(await runTmux([], new AbortController().signal), "custom name\r");
		});
	});

	await suite.test("rejects and reaps a child that exceeds its output bound", async () => {
		await withNativeFakeTmux(() => [
			"process.stdout.write('x'.repeat(70 * 1024));",
			"setInterval(() => {}, 1000);",
		], async ({ pid }) => {
			const command = runTmux([], new AbortController().signal).then(
				() => undefined,
				(error: unknown) => error as NodeError,
			);
			const childPid = await waitForChild(pid);
			const error = await command;
			assert.equal(error?.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
			assert.equal(await childHasExited(childPid), true);
		});
	});

	await suite.test("reaps a child on cancellation", async () => {
		await withNativeFakeTmux(() => [
			"process.on('SIGTERM', () => {});",
			"setInterval(() => {}, 1000);",
		], async ({ pid }) => {
			const controller = new AbortController();
			const command = runTmux([], controller.signal);
			const rejected = observeRejection(command);
			const childPid = await waitForChild(pid);
			controller.abort();
			assert.equal(await rejected, true);
			assert.equal(await childHasExited(childPid), true);
		});
	});

	await suite.test("rejects a timed-out child that exits cleanly after SIGTERM", {
		skip: process.platform === "win32",
	}, async () => {
		await withNativeFakeTmux(({ cleanExit }) => [
			"process.on('SIGTERM', () => setTimeout(() => {",
			`require("node:fs").writeFileSync(${JSON.stringify(cleanExit)}, "clean");`,
			"process.exit(0);",
			"}, 100));",
			"setInterval(() => {}, 1000);",
		], async ({ pid, cleanExit }) => {
			const command = runTmux([], new AbortController().signal);
			const rejected = observeRejection(command);
			const childPid = await waitForChild(pid);
			assert.equal(await rejected, true);
			assert.equal(await childHasExited(childPid), true);
			assert.equal(readFileSync(cleanExit, "utf8"), "clean");
		});
	});
});
