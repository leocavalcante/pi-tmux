import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piTmux, { WAITING_OPTION, type RunTmux } from "../index";

const hasTmux = Bun.which("tmux") !== null;
type Fixture = {
	tmux: (...args: string[]) => string;
	calls: string[][];
	warnings: string[];
	beforeCommand?: (args: string[], signal: AbortSignal) => Promise<void>;
	emit: (event: string, reason?: string) => Promise<void>;
	pin: (title: string) => Promise<void>;
};

async function withServer(run: (fixture: Fixture) => Promise<void>) {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-move-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	const handlers = new Map<string, Function>();
	const commands = new Map<string, Function>();
	const warnings: string[] = [];
	const ctx = {
		mode: "tui",
		ui: { notify: (text: string, level: string) => { if (level === "warning") warnings.push(text); } },
	} as unknown as ExtensionContext;
	const fixture: Fixture = {
		tmux: (...args) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
			encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
		}).replace(/\r?\n$/, ""),
		calls: [], warnings,
		emit: async (event, reason = "quit") => {
			await handlers.get(event)!({ type: event, reason }, ctx);
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
		pin: async (title) => { await commands.get("tmux-title")!("set " + title, ctx); },
	};
	const tmux: RunTmux = async (args, signal) => {
		fixture.calls.push(args);
		await fixture.beforeCommand?.(args, signal);
		return fixture.tmux(...args);
	};
	try {
		process.env.PI_TMUX_MODEL = "off";
		piTmux({
			on: (event: string, handler: Function) => handlers.set(event, handler),
			registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command.handler),
		} as unknown as ExtensionAPI, tmux);
		await run(fixture);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
		else process.env.PI_TMUX_MODEL = originalModel;
		try { fixture.tmux("kill-server"); } catch { /* Server may already be gone. */ }
		rmSync(directory, { recursive: true, force: true });
	}
}

const movingCases = [
	{ sameSession: false, peerWaiting: false, otherWindowWaiting: false },
	{ sameSession: false, peerWaiting: true, otherWindowWaiting: false },
	{ sameSession: false, peerWaiting: false, otherWindowWaiting: true },
	{ sameSession: true, peerWaiting: false, otherWindowWaiting: false },
];

test.skipIf(!hasTmux).each(movingCases)("moving a waiting pane repairs its former markers: %j", async ({ sameSession, peerWaiting, otherWindowWaiting }) => {
	await withServer(async (f) => {
		const sourceName = "My Café Session " + "X".repeat(40) + " #{session_id}";
		const pane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", sourceName.replaceAll("#", "##"), "/bin/sleep 60");
		const source = f.tmux("display-message", "-p", "-t", pane, "#{session_id}");
		const anchor = f.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		f.tmux("set-option", "-p", "-t", anchor, WAITING_OPTION, peerWaiting ? "1" : "0");
		const elsewhere = f.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", source, "/bin/sleep 60");
		f.tmux("set-option", "-p", "-t", elsewhere, WAITING_OPTION, otherWindowWaiting ? "1" : "0");
		const destination = sameSession
			? f.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", source, "/bin/sleep 60")
			: f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Destination", "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		await f.pin("move task");
		await f.emit("agent_settled");
		expect(f.tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe("* move task");
		expect(f.tmux("display-message", "-p", "-t", source, "#{session_name}")).toBe("* " + sourceName);

		f.tmux("join-pane", "-d", "-s", pane, "-t", destination);
		await f.emit("agent_settled");
		expect(f.tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe(peerWaiting ? "* move task" : "move task");
		const sourceWaiting = sameSession || peerWaiting || otherWindowWaiting;
		expect(f.tmux("display-message", "-p", "-t", source, "#{session_name}")).toBe((sourceWaiting ? "* " : "") + sourceName);
		expect(f.tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("* move task");
		expect(f.tmux("display-message", "-p", "-t", pane, "#{session_name}")).toBe("* " + (sameSession ? sourceName : "Destination"));
		expect(f.tmux("show-options", "-p", "-v", "-t", anchor, WAITING_OPTION)).toBe(peerWaiting ? "1" : "0");
		expect(f.tmux("show-options", "-p", "-v", "-t", elsewhere, WAITING_OPTION)).toBe(otherWindowWaiting ? "1" : "0");
		expect(f.warnings).toEqual([]);
	});
});

test.skipIf(!hasTmux).each([false, true])("former-window repair preserves late literal titles and server-side status, initially waiting=%j", async (initialWaiting) => {
	await withServer(async (f) => {
		const pane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Source", "/bin/sleep 60");
		const source = f.tmux("display-message", "-p", "-t", pane, "#{session_id}");
		const oldWindow = f.tmux("display-message", "-p", "-t", pane, "#{window_id}");
		const anchor = f.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		const destination = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Destination", "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		await f.pin("move task");
		await f.emit("agent_settled");
		f.tmux("set-option", "-p", "-t", anchor, WAITING_OPTION, initialWaiting ? "1" : "0");
		f.tmux("join-pane", "-d", "-s", pane, "-t", destination);
		const latestTitle = "literal #{session_id}, -peer " + "x".repeat(24) + "'; new-window -n injected; #";
		let flipped = false;
		f.beforeCommand = async (args) => {
			if (!flipped && args[0] === "if-shell" && args[3] === oldWindow) {
				flipped = true;
				f.tmux("set-option", "-p", "-t", anchor, WAITING_OPTION, initialWaiting ? "0" : "1");
				f.tmux("rename-window", "-t", anchor, "--", ("* " + latestTitle).replaceAll("#", "##"));
			}
		};
		await f.emit("agent_settled");
		expect(flipped).toBe(true);
		expect(f.tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe(initialWaiting ? latestTitle : "* " + latestTitle.slice(0, 22));
		expect(f.tmux("display-message", "-p", "-t", source, "#{session_name}")).toBe(initialWaiting ? "Source" : "* Source");
		expect(f.tmux("list-windows", "-a", "-F", "#{window_id}").split("\n")).toHaveLength(2);
		expect(f.tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("* move task");
		expect(f.warnings).toEqual([]);
	});
});

test.skipIf(!hasTmux).each(["window", "session"])("a further move during former-%s repair refreshes the intermediate and final locations", async (phase) => {
	await withServer(async (f) => {
		const pane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Source", "/bin/sleep 60");
		const source = f.tmux("display-message", "-p", "-t", pane, "#{session_id}");
		const sourceWindow = f.tmux("display-message", "-p", "-t", pane, "#{window_id}");
		const anchor = f.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		const middle = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Middle", "/bin/sleep 60");
		const destination = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Destination", "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		await f.pin("move task");
		await f.emit("agent_settled");
		f.tmux("join-pane", "-d", "-s", pane, "-t", middle);
		let moved = false;
		f.beforeCommand = async (args) => {
			const repair = phase === "window" ? args[0] === "if-shell" && args[3] === sourceWindow
				: args[0] === "rename-session" && args[2] === source;
			if (!moved && repair) {
				moved = true;
				f.tmux("rename-window", "-t", middle, "--", "* intermediate task");
				f.tmux("join-pane", "-d", "-s", pane, "-t", destination);
			}
		};
		await f.emit("agent_settled");
		expect(moved).toBe(true);
		expect(f.tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe("move task");
		expect(f.tmux("display-message", "-p", "-t", source, "#{session_name}")).toBe("Source");
		expect(f.tmux("display-message", "-p", "-t", middle, "#{window_name}")).toBe("intermediate task");
		expect(f.tmux("display-message", "-p", "-t", middle, "#{session_name}")).toBe("Middle");
		expect(f.tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("* move task");
		expect(f.tmux("display-message", "-p", "-t", pane, "#{session_name}")).toBe("* Destination");
		expect(f.warnings).toEqual([]);
	});
});

test.skipIf(!hasTmux).each(["window", "session"])("transient former-%s repair failures are retried without blocking current titles", async (phase) => {
	await withServer(async (f) => {
		const pane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Source", "/bin/sleep 60");
		const source = f.tmux("display-message", "-p", "-t", pane, "#{session_id}");
		const oldWindow = f.tmux("display-message", "-p", "-t", pane, "#{window_id}");
		const anchor = f.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		const destination = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Destination", "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		await f.pin("move task");
		await f.emit("agent_settled");
		f.tmux("join-pane", "-d", "-s", pane, "-t", destination);
		const isRepair = (args: string[]) => phase === "window" ? args[0] === "if-shell" && args[3] === oldWindow
			: args[0] === "rename-session" && args[2] === source;
		let failed = false;
		f.beforeCommand = async (args) => {
			if (!failed && isRepair(args)) {
				failed = true;
				throw new Error("Synthetic transient tmux failure");
			}
		};
		await f.emit("agent_settled");
		expect(failed).toBe(true);
		expect(f.tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe(phase === "window" ? "* move task" : "move task");
		expect(f.tmux("display-message", "-p", "-t", source, "#{session_name}")).toBe(phase === "session" ? "* Source" : "Source");
		expect(f.tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("* move task");
		await f.emit("agent_settled");
		expect(f.calls.filter(isRepair)).toHaveLength(2);
		expect(f.tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe("move task");
		expect(f.tmux("display-message", "-p", "-t", source, "#{session_name}")).toBe("Source");
		expect(f.warnings).toEqual([]);
	});
});

test.skipIf(!hasTmux)("destroyed former windows and sessions do not prevent destination updates", async () => {
	await withServer(async (f) => {
		const pane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Source", "/bin/sleep 60");
		const source = f.tmux("display-message", "-p", "-t", pane, "#{session_id}");
		const oldWindow = f.tmux("display-message", "-p", "-t", pane, "#{window_id}");
		const destination = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Destination", "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		await f.pin("move task");
		await f.emit("agent_settled");
		f.tmux("join-pane", "-d", "-s", pane, "-t", destination);
		await f.emit("agent_settled");
		expect(f.tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("* move task");
		expect(f.warnings).toEqual([]);
		const repairs = f.calls.filter((args) => args[3] === oldWindow || args[2] === source).length;
		await f.emit("agent_settled");
		expect(f.calls.filter((args) => args[3] === oldWindow || args[2] === source)).toHaveLength(repairs);
		expect(f.warnings).toEqual([]);
	});
});

test.skipIf(!hasTmux)("move cleanup leaves unmarked custom names and automatic naming alone", async () => {
	await withServer(async (f) => {
		const pane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Source", "/bin/sleep 60");
		const anchor = f.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		const destination = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Destination", "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		await f.emit("session_start");
		f.tmux("rename-window", "-t", anchor, "--", "Custom Café #{session_id}".replaceAll("#", "##"));
		f.tmux("set-window-option", "-t", anchor, "automatic-rename-format", "Custom Café ##{session_id}");
		f.tmux("set-window-option", "-t", anchor, "automatic-rename", "on");
		f.tmux("join-pane", "-d", "-s", pane, "-t", destination);
		await f.emit("session_start");
		expect(f.tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe("Custom Café #{session_id}");
		expect(f.tmux("show-window-options", "-v", "-t", anchor, "automatic-rename")).toBe("on");
		expect(f.warnings).toEqual([]);
	});
});

test.skipIf(!hasTmux)("a late custom unmarked title prevents repair from disabling automatic naming", async () => {
	await withServer(async (f) => {
		const pane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Source", "/bin/sleep 60");
		const oldWindow = f.tmux("display-message", "-p", "-t", pane, "#{window_id}");
		const anchor = f.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		const destination = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Destination", "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		await f.pin("move task");
		await f.emit("agent_settled");
		f.tmux("join-pane", "-d", "-s", pane, "-t", destination);
		let changed = false;
		f.beforeCommand = async (args) => {
			if (!changed && args[0] === "if-shell" && args[3] === oldWindow) {
				changed = true;
				f.tmux("rename-window", "-t", anchor, "--", "Late Custom ##{session_id}");
				f.tmux("set-window-option", "-t", anchor, "automatic-rename-format", "Late Custom ##{session_id}");
				f.tmux("set-window-option", "-t", anchor, "automatic-rename", "on");
			}
		};
		await f.emit("agent_settled");
		expect(changed).toBe(true);
		expect(f.tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe("Late Custom #{session_id}");
		expect(f.tmux("show-window-options", "-v", "-t", anchor, "automatic-rename")).toBe("on");
		expect(f.warnings).toEqual([]);
	});
});

test.skipIf(!hasTmux).each(["pin", "reload"])("superseding a move update retains its pending former-location repairs: %s", async (replacement) => {
	await withServer(async (f) => {
		const pane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Source", "/bin/sleep 60");
		const source = f.tmux("display-message", "-p", "-t", pane, "#{session_id}");
		const oldWindow = f.tmux("display-message", "-p", "-t", pane, "#{window_id}");
		const anchor = f.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		const destination = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Destination", "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		await f.pin("move task");
		await f.emit("agent_settled");
		f.tmux("join-pane", "-d", "-s", pane, "-t", destination);
		f.tmux("rename-window", "-t", destination, "--", "destination task");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let held = false;
		f.beforeCommand = async (args) => {
			if (!held && args[0] === "if-shell" && args[3] === oldWindow) {
				held = true;
				await gate;
			}
		};
		const older = f.emit("agent_settled");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(held).toBe(true);
		const newer = replacement === "pin" ? f.pin("next task") : f.emit("session_shutdown", "reload");
		release();
		await older;
		await newer;
		expect(f.tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe("move task");
		expect(f.tmux("display-message", "-p", "-t", source, "#{session_name}")).toBe("Source");
		expect(f.tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe(replacement === "pin" ? "* next task" : "destination task");
		expect(f.warnings).toEqual([]);
	});
});

test("continuous moves and transient failures keep stabilization and repair queues bounded", async () => {
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	const handlers = new Map<string, Function>();
	const calls: string[][] = [];
	const warnings: string[] = [];
	let location = 0;
	try {
		process.env.TMUX_PANE = "%901";
		process.env.PI_TMUX_MODEL = "off";
		piTmux({
			on: (event: string, handler: Function) => handlers.set(event, handler),
			registerCommand: () => {},
		} as unknown as ExtensionAPI, async (args) => {
			calls.push(args);
			if (args[0] === "display-message") {
				location++;
				return `$${location}\t@${location}\t0\tcustom name`;
			}
			if (args[0] === "if-shell" || args[0] === "rename-session") throw new Error("Synthetic transient failure");
			return "";
		});
		const ctx = { mode: "tui", ui: { notify: (text: string) => warnings.push(text) } } as unknown as ExtensionContext;
		await handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx);
		const firstCalls = calls.length;
		await handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx);
		const secondCalls = calls.slice(firstCalls);
		expect(calls.filter((args) => args[0] === "set-option")).toHaveLength(8);
		expect(calls.filter((args) => args[0] === "display-message")).toHaveLength(18);
		expect(secondCalls.filter((args) => args[0] === "if-shell")).toHaveLength(32);
		expect(secondCalls.filter((args) => args[0] === "rename-session")).toHaveLength(32);
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
		else process.env.PI_TMUX_MODEL = originalModel;
	}
});
