import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildQuitPaneWatcherCommand } from "../src/extension.ts";
import { cleanupTmuxFixture, supportsUnixTmux } from "./tmux-support.ts";

const hasTmux = supportsUnixTmux(process.platform, Bun.which("tmux"));

test.skipIf(!hasTmux)("quit-pane watcher waits for Pi and closes only its pane", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-quit-pane-"));
	const socket = join(directory, "socket");
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "");
	try {
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "QuitPane", "/bin/sleep 60");
		const sibling = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		const serverPid = tmux("display-message", "-p", "-t", pane, "#{pid}");
		const piProcess = spawn("/bin/sleep", ["0.2"], { stdio: "ignore" });
		if (!piProcess.pid) throw new Error("Could not start watcher test process");
		const processExit = new Promise<void>((resolve, reject) => {
			piProcess.once("error", reject);
			piProcess.once("exit", () => resolve());
		});
		tmux("run-shell", "-b", buildQuitPaneWatcherCommand(pane, piProcess.pid, serverPid));
		await processExit;

		const deadline = Date.now() + 5_000;
		while (tmux("list-panes", "-a", "-F", "#{pane_id}").split("\n").includes(pane)) {
			if (Date.now() >= deadline) throw new Error("Watcher did not close the Pi pane");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(tmux("display-message", "-p", "-t", sibling, "#{pane_id}")).toBe(sibling);
	} finally {
		cleanupTmuxFixture(() => tmux("kill-server"), directory);
	}
});
