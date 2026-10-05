import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_TITLE_FORMAT, WAITING_OPTION } from "../index";

const hasTmux = Bun.which("tmux") !== null;

test.skipIf(!hasTmux)("tmux aggregates waiting panes across windows and preserves session names", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	try {
		const name = "My Café Session " + "X".repeat(40) + " #{session_id}";
		const session = tmux("new-session", "-d", "-P", "-F", "#{session_id}", "-s", name.replaceAll("#", "##"), "/bin/sleep 60");
		const firstPane = tmux("display-message", "-p", "-t", session, "#{pane_id}");
		const secondPane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", session, "/bin/sleep 60");
		const splitPane = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", firstPane, "/bin/sleep 60");
		const update = (pane: string, waiting: boolean) => tmux(
			"set-option", "-p", "-t", pane, WAITING_OPTION, waiting ? "1" : "0",
			";", "rename-session", "-t", session, SESSION_TITLE_FORMAT,
		);
		const title = () => tmux("display-message", "-p", "-t", session, "#{session_name}");
		expect(title()).toBe(name);

		update(firstPane, true);
		expect(title()).toBe("* " + name);
		update(firstPane, true);
		expect(title()).toBe("* " + name);
		update(secondPane, false);
		expect(title()).toBe("* " + name);
		update(secondPane, true);
		update(firstPane, false);
		expect(title()).toBe("* " + name);
		update(splitPane, true);
		update(secondPane, false);
		expect(title()).toBe("* " + name);
		update(splitPane, false);
		expect(title()).toBe(name);
	} finally {
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});
