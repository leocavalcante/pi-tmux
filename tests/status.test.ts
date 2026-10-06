import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piTmux, { STATUS_INFO_FORMAT, WAITING_OPTION, type RunTmux } from "../index";

const hasTmux = Bun.which("tmux") !== null;

test.skipIf(!hasTmux).each([
	{ own: false, peer: false, elsewhere: false, flags: "pane no, window no, session no" },
	{ own: true, peer: false, elsewhere: false, flags: "pane yes, window yes, session yes" },
	{ own: false, peer: true, elsewhere: false, flags: "pane no, window yes, session yes" },
	{ own: false, peer: false, elsewhere: true, flags: "pane no, window no, session yes" },
	{ own: "2", peer: false, elsewhere: false, flags: "pane no, window no, session no" },
	{ own: "10", peer: false, elsewhere: false, flags: "pane yes, window yes, session yes" },
])("status reads real tmux aggregation without changing names or flags: %j", async ({ own, peer, elsewhere, flags }) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-status-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "");
	try {
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Synthetic Session", "-n", "synthetic private title", "/bin/sleep 60");
		const session = tmux("display-message", "-p", "-t", pane, "#{session_id}");
		const window = tmux("display-message", "-p", "-t", pane, "#{window_id}");
		const sibling = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		const otherPane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", session, "-n", "another window", "/bin/sleep 60");
		for (const [target, waiting] of [[pane, own], [sibling, peer], [otherPane, elsewhere]] as const) {
			tmux("set-option", "-p", "-t", target, WAITING_OPTION, typeof waiting === "string" ? waiting : waiting ? "1" : "0");
		}
		const snapshot = () => [
			tmux("list-windows", "-a", "-F", "#{window_id}\t#{window_name}\t#{automatic-rename}"),
			tmux("display-message", "-p", "-t", session, "#{session_name}"),
			...[pane, sibling, otherPane].map((target) => tmux("show-options", "-p", "-t", target)),
		];
		const before = snapshot();
		process.env.TMUX_PANE = pane;
		process.env.PI_TMUX_MODEL = "off";
		const commands = new Map<string, Function>();
		const calls: string[][] = [];
		const notices: string[] = [];
		const warnings: string[] = [];
		const run: RunTmux = async (args) => { calls.push(args); return tmux(...args); };
		piTmux({
			on: () => {},
			registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command.handler),
		} as unknown as ExtensionAPI, run);
		const ctx = {
			mode: "tui",
			ui: { notify: (text: string, level: string) => (level === "warning" ? warnings : notices).push(text) },
		} as unknown as ExtensionContext;
		await commands.get("tmux-title")!("status", ctx);
		expect(notices[0]).toContain("Waiting flags: " + flags);
		expect(notices[0]).toContain(`Targets: pane ${pane}, window ${window}, session ${session}`);
		expect(notices[0]).toContain("AI naming: off");
		expect(notices[0]).not.toContain("synthetic private title");
		expect(notices[0]).not.toContain("Synthetic Session");
		expect(calls).toEqual([["display-message", "-p", "-t", pane, STATUS_INFO_FORMAT]]);
		expect(snapshot()).toEqual(before);
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
		else process.env.PI_TMUX_MODEL = originalModel;
		try { tmux("kill-server"); } catch { /* Already gone. */ }
		rmSync(directory, { recursive: true, force: true });
	}
});
