import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export type FakeTmuxFiles = { pid: string; cleanExit: string };

export async function withFakeTmux(
	nodeExecutable: string,
	script: (files: FakeTmuxFiles) => string[],
	action: (files: FakeTmuxFiles) => Promise<void>,
): Promise<void> {
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

export async function waitForChild(pidFile: string): Promise<number> {
	const deadline = Date.now() + 1_000;
	while (!existsSync(pidFile) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (!existsSync(pidFile)) throw new Error("Fake tmux did not start");
	const pid = Number(readFileSync(pidFile, "utf8"));
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Fake tmux returned an invalid PID");
	return pid;
}

export function observeRejection(promise: Promise<unknown>): Promise<boolean> {
	return promise.then(
		() => false,
		() => true,
	);
}

export async function childHasExited(pid: number): Promise<boolean> {
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
