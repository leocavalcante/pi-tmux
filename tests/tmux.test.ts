import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runTmux } from "../src/tmux.ts";

async function withFakeTmux(
	script: (files: { pid: string; cleanExit: string }) => string[],
	action: (files: { pid: string; cleanExit: string }) => Promise<void>,
) {
	const nodeExecutable = Bun.which("node");
	if (!nodeExecutable) throw new Error("Node.js is required for the fake tmux executable");
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-timeout-"));
	const executable = join(directory, process.platform === "win32" ? "tmux.exe" : "tmux");
	const loader = join(directory, "fake-tmux.cjs");
	const files = { pid: join(directory, "pid"), cleanExit: join(directory, "clean-exit") };
	const originalPath = process.env.PATH;
	const originalNodeOptions = process.env.NODE_OPTIONS;
	let completed = false;
	try {
		copyFileSync(nodeExecutable, executable);
		if (process.platform !== "win32") chmodSync(executable, 0o755);
		writeFileSync(loader, [
			`if (require("node:path").basename(process.execPath).toLowerCase() === ${JSON.stringify(process.platform === "win32" ? "tmux.exe" : "tmux")}) {`,
			"process.argv.splice(1);",
			`require("node:fs").writeFileSync(${JSON.stringify(files.pid)}, String(process.pid));`,
			...script(files),
			"}",
			"",
		].join("\n"));
		process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
		process.env.NODE_OPTIONS = [
			originalNodeOptions,
			`--require=${JSON.stringify(loader.replaceAll("\\", "/"))}`,
		].filter(Boolean).join(" ");
		await action(files);
		completed = true;
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = originalNodeOptions;
		try {
			if (!completed && existsSync(files.pid)) {
				const pid = Number(readFileSync(files.pid, "utf8"));
				if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
			}
		} catch { /* Best-effort cleanup must not mask the test result. */ }
		try { rmSync(directory, { recursive: true, force: true }); } catch { /* Do not mask the test result. */ }
	}
}

async function waitForChild(pidFile: string): Promise<number> {
	const deadline = Date.now() + 1_000;
	while (!existsSync(pidFile) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (!existsSync(pidFile)) throw new Error("Fake tmux did not start");
	const pid = Number(readFileSync(pidFile, "utf8"));
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Fake tmux returned an invalid PID");
	return pid;
}

function observeRejection(promise: Promise<unknown>): Promise<boolean> {
	return promise.then(
		() => false,
		() => true,
	);
}

async function childHasExited(pid: number): Promise<boolean> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try { process.kill(pid, 0); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return false;
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
