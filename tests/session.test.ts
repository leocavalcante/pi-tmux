import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piTmux, { SESSION_TITLE_FORMAT, WAITING_OPTION, type RunTmux } from "../index";

const hasTmux = Bun.which("tmux") !== null;
let originalModel: string | undefined;
beforeEach(() => {
	originalModel = process.env.PI_TMUX_MODEL;
	delete process.env.PI_TMUX_MODEL;
});
afterEach(() => {
	if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
	else process.env.PI_TMUX_MODEL = originalModel;
});

const mockPi = (handlers: Map<string, Function>) => ({
	on: (event: string, handler: Function) => handlers.set(event, handler),
	registerCommand: () => {},
}) as unknown as ExtensionAPI;

test.skipIf(!hasTmux).each([
	{ sourceTitle: "existing task", destinationTitle: "existing task", event: "agent_settled", expectedTitle: "* existing task" },
	{ sourceTitle: "existing task", destinationTitle: "destination task", event: "agent_settled", expectedTitle: "* destination task" },
	{ sourceTitle: "zsh", destinationTitle: "destination task", event: "session_shutdown", expectedTitle: "zsh" },
])("renames follow a pane moved between lookup and status writes: %j", async ({ sourceTitle, destinationTitle, event, expectedTitle }) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	try {
		const source = tmux("new-session", "-d", "-P", "-F", "#{session_id}", "-s", "Source", "-n", sourceTitle, "/bin/sleep 60");
		const pane = tmux("display-message", "-p", "-t", source, "#{pane_id}");
		const anchor = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		const destination = tmux("new-session", "-d", "-P", "-F", "#{session_id}", "-s", "Destination", "-n", destinationTitle, "/bin/sleep 60");
		const destinationPane = tmux("display-message", "-p", "-t", destination, "#{pane_id}");
		process.env.TMUX_PANE = pane;
		let move = true;
		const run: RunTmux = async (args) => {
			const result = tmux(...args);
			if (move && args[0] === "display-message") {
				move = false;
				tmux("join-pane", "-d", "-s", pane, "-t", destinationPane);
			}
			return result;
		};
		const handlers = new Map<string, Function>();
		piTmux(mockPi(handlers), run);
		const warnings: string[] = [];
		const ctx = {
			mode: "tui",
			sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
			ui: { notify: (text: string) => warnings.push(text) },
		} as unknown as ExtensionContext;
		await handlers.get(event)!({ type: event, reason: "quit" }, ctx);
		expect(tmux("display-message", "-p", "-t", destination, "#{session_name}")).toBe(event === "agent_settled" ? "* Destination" : "Destination");
		expect(tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe(expectedTitle);
		expect(tmux("display-message", "-p", "-t", source, "#{session_name}")).toBe("Source");
		expect(tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe(sourceTitle);
		expect(tmux("show-options", "-p", "-v", "-t", pane, WAITING_OPTION)).toBe(event === "agent_settled" ? "1" : "0");
		await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
		expect(tmux("display-message", "-p", "-t", destination, "#{session_name}")).toBe("Destination");
		expect(tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("zsh");
		expect(tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe(sourceTitle);
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});

test.skipIf(!hasTmux)("leading-hyphen titles remain literal when clearing a waiting marker", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	try {
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "LiteralTitle", "-n", "-fix auth", "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		const handlers = new Map<string, Function>();
		piTmux(mockPi(handlers), async (args) => tmux(...args));
		const warnings: string[] = [];
		const ctx = {
			mode: "tui",
			sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
			ui: { notify: (text: string) => warnings.push(text) },
		} as unknown as ExtensionContext;
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("* -fix auth");
		await handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx);
		expect(tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("-fix auth");
		expect(tmux("display-message", "-p", "-t", pane, "#{session_name}")).toBe("LiteralTitle");
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});

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
