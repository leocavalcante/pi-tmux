import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piTmux, { STATUS_INFO_FORMAT, WAITING_OPTION, type RunTmux } from "../index";

const hasTmux = Bun.which("tmux") !== null;
const sessionRenameTarget = (args: string[]) => {
	const command = args.indexOf("rename-session");
	return command < 0 ? undefined : args[command + 2];
};

function parseTmuxCommand(command: string): string[] {
	const args: string[] = [];
	for (let index = 0; index < command.length;) {
		while (/\s/.test(command[index] ?? "")) index++;
		if (index >= command.length) break;
		if (command[index] === ";") { args.push(";"); index++; continue; }
		expect(command[index]).toBe('"');
		index++;
		let value = "";
		while (index < command.length && command[index] !== '"') {
			if (command[index] === "\\") index++;
			value += command[index++];
		}
		expect(command[index]).toBe('"');
		index++;
		args.push(value);
	}
	return args;
}

function observedCommand(args: string[]): string[] {
	if (args[0] !== "if-shell" || args[1] !== "-F" || !/^#\{==:#\{pid\},\d+\}$/.test(args[2])) return args;
	return parseTmuxCommand(args[3]);
}

type Fixture = {
	tmux: (...args: string[]) => string;
	calls: string[][];
	rawCalls: string[][];
	warnings: string[];
	notices: string[];
	beforeCommand?: (args: string[], signal: AbortSignal) => Promise<void>;
	emit: (event: string, reason?: string) => Promise<void>;
	pin: (title: string) => Promise<void>;
	status: () => Promise<string>;
	sync: () => Promise<string>;
};

async function waitForProcessExit(pidText: string) {
	const pid = Number(pidText);
	if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid tmux server PID");
	const deadline = Date.now() + 2_000;
	while (true) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
			throw error;
		}
		if (Date.now() >= deadline) throw new Error(`tmux server ${pid} did not exit`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function withServer(run: (fixture: Fixture) => Promise<void>) {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-move-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	const handlers = new Map<string, Function>();
	const commands = new Map<string, Function>();
	const warnings: string[] = [];
	const notices: string[] = [];
	const ctx = {
		mode: "tui",
		ui: { notify: (text: string, level: string) => (level === "warning" ? warnings : notices).push(text) },
	} as unknown as ExtensionContext;
	const fixture: Fixture = {
		tmux: (...args) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
			encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
		}).replace(/\r?\n$/, ""),
		calls: [], rawCalls: [], warnings, notices,
		emit: async (event, reason = "quit") => {
			await handlers.get(event)!({ type: event, reason }, ctx);
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
		pin: async (title) => { await commands.get("tmux-title")!("set " + title, ctx); },
		status: async () => { await commands.get("tmux-title")!("status", ctx); return notices.at(-1)!; },
		sync: async () => { await commands.get("tmux-title")!("sync", ctx); return notices.at(-1)!; },
	};
	const tmux: RunTmux = async (args, signal) => {
		fixture.rawCalls.push(args);
		const observed = observedCommand(args);
		fixture.calls.push(observed);
		await fixture.beforeCommand?.(observed, signal);
		return fixture.tmux(...args);
	};
	tmux.supportsServerPidGuard = true;
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

test.skipIf(!hasTmux)("a server restart after lookup cannot apply the pending batch to reused IDs", async () => {
	await withServer(async (f) => {
		const pane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Old Server", "-n", "old title", "/bin/sleep 60");
		const [oldSession, oldWindow, oldServer] = f.tmux(
			"display-message", "-p", "-t", pane, "#{session_id}\t#{window_id}\t#{pid}",
		).split("\t");
		process.env.TMUX_PANE = pane;
		let restarted = false;
		f.beforeCommand = async (args) => {
			if (restarted || args[0] !== "set-option") return;
			restarted = true;
			f.tmux("kill-server");
			await waitForProcessExit(oldServer);
			const replacementPane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Replacement", "-n", "untouched", "/bin/sleep 60");
			const [session, window, server] = f.tmux(
				"display-message", "-p", "-t", replacementPane, "#{session_id}\t#{window_id}\t#{pid}",
			).split("\t");
			expect(replacementPane).toBe(pane);
			expect([session, window]).toEqual([oldSession, oldWindow]);
			expect(server).not.toBe(oldServer);
		};

		await f.emit("session_start");
		expect(restarted).toBe(true);
		expect(f.tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("untouched");
		expect(f.tmux("display-message", "-p", "-t", pane, "#{session_name}")).toBe("Replacement");
		const guardedWrite = f.rawCalls.find((args) => args[0] === "if-shell");
		expect(guardedWrite?.[2]).toBe(`#{==:#{pid},${oldServer}}`);

		const afterDetection = f.rawCalls.length;
		await f.emit("agent_settled");
		expect(f.rawCalls.slice(afterDetection).filter((args) => args[0] !== "display-message")).toEqual([]);
		expect(f.warnings).toEqual([]);
	});
});

const movingCases = [
	{ sameSession: false, peerWaiting: false, otherWindowWaiting: false },
	{ sameSession: false, peerWaiting: true, otherWindowWaiting: false },
	{ sameSession: false, peerWaiting: false, otherWindowWaiting: true },
	{ sameSession: true, peerWaiting: false, otherWindowWaiting: false },
];

test.skipIf(!hasTmux)("a guarded title rename skipped by a server restart is not reported as applied", async () => {
	await withServer(async (f) => {
		const pane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Old Server", "-n", "old title", "/bin/sleep 60");
		const [oldSession, oldWindow, oldServer] = f.tmux(
			"display-message", "-p", "-t", pane, "#{session_id}\t#{window_id}\t#{pid}",
		).split("\t");
		process.env.TMUX_PANE = pane;
		let restarted = false;
		f.beforeCommand = async (args) => {
			if (restarted || args[0] !== "rename-window") return;
			restarted = true;
			f.tmux("kill-server");
			await waitForProcessExit(oldServer);
			const replacementPane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Replacement", "-n", "untouched", "/bin/sleep 60");
			const [session, window, server] = f.tmux(
				"display-message", "-p", "-t", replacementPane, "#{session_id}\t#{window_id}\t#{pid}",
			).split("\t");
			expect(replacementPane).toBe(pane);
			expect([session, window]).toEqual([oldSession, oldWindow]);
			expect(server).not.toBe(oldServer);
		};

		await f.pin("requested title");
		expect(restarted).toBe(true);
		expect(f.tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("untouched");
		expect(f.notices).toEqual([]);
		expect(f.warnings).toEqual([]);

		const afterDetection = f.rawCalls.length;
		await f.emit("agent_settled");
		expect(f.rawCalls.slice(afterDetection)).toEqual([]);
	});
});

test.skipIf(!hasTmux).each(movingCases)("moving a waiting pane preserves literal session names and repairs former markers: %j", async ({ sameSession, peerWaiting, otherWindowWaiting }) => {
	await withServer(async (f) => {
		const requestedSourceName = 'My "Café", {group}: 🧪 Session \\\\ ' + "X".repeat(40) + " \\ #{session_id}\u2003  ";
		const pane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", requestedSourceName.replaceAll("#", "##"), "/bin/sleep 60");
		const sourceName = f.tmux("display-message", "-p", "-t", pane, "#{session_name}");
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
				: sessionRenameTarget(args) === source;
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
			: sessionRenameTarget(args) === source;
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

test.skipIf(!hasTmux).each([
	{ sameSession: true, peerWaiting: false },
	{ sameSession: false, peerWaiting: false },
	{ sameSession: false, peerWaiting: true },
])("sync observes pane moves and repairs markers without another lifecycle event: %j", async ({ sameSession, peerWaiting }) => {
	await withServer(async (f) => {
		const pane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Source", "/bin/sleep 60");
		const source = f.tmux("display-message", "-p", "-t", pane, "#{session_id}");
		const anchor = f.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		const destination = sameSession
			? f.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", source, "/bin/sleep 60")
			: f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Destination", "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		await f.pin("move task");
		await f.emit("agent_settled");
		if (peerWaiting) f.tmux("set-option", "-p", "-t", anchor, WAITING_OPTION, "1");
		f.tmux("join-pane", "-d", "-s", pane, "-t", destination);
		expect(await f.sync()).toBe("tmux title and waiting markers synchronized.");
		expect(f.tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("* move task");
		expect(f.tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe(peerWaiting ? "* move task" : "move task");
		expect(f.tmux("display-message", "-p", "-t", source, "#{session_name}")).toBe(sameSession || peerWaiting ? "* Source" : "Source");
		expect(f.warnings).toEqual([]);
	});
});

test.skipIf(!hasTmux)("sync reports retained transient repairs instead of claiming complete success", async () => {
	await withServer(async (f) => {
		const pane = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Source", "/bin/sleep 60");
		const oldWindow = f.tmux("display-message", "-p", "-t", pane, "#{window_id}");
		const anchor = f.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		const destination = f.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Destination", "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		await f.pin("move task");
		await f.emit("agent_settled");
		f.tmux("join-pane", "-d", "-s", pane, "-t", destination);
		f.beforeCommand = async (args) => {
			if (args[0] === "if-shell" && args[3] === oldWindow) throw new Error("Synthetic transient failure");
		};
		expect(await f.sync()).toBe("Current tmux status synchronized; some former-location repairs remain queued.");
		expect(await f.status()).toContain("Pending move repairs: windows 1, sessions 0");
		f.beforeCommand = undefined;
		expect(await f.sync()).toBe("tmux title and waiting markers synchronized.");
		expect(f.tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe("move task");
		expect(await f.status()).toContain("Pending move repairs: windows 0, sessions 0");
		expect(f.warnings).toEqual([]);
	});
});

test.skipIf(!hasTmux)("status reports queued move repairs without consuming them", async () => {
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
		f.beforeCommand = async (args) => {
			if ((args[0] === "if-shell" && args[3] === oldWindow)
				|| sessionRenameTarget(args) === source) throw new Error("Synthetic transient failure");
		};
		await f.emit("agent_settled");
		const beforeStatus = f.calls.length;
		expect(await f.status()).toContain("Pending move repairs: windows 1, sessions 1");
		expect(f.calls.slice(beforeStatus)).toEqual([["display-message", "-p", "-t", pane, STATUS_INFO_FORMAT]]);
		f.beforeCommand = undefined;
		await f.emit("agent_settled");
		expect(f.tmux("display-message", "-p", "-t", anchor, "#{window_name}")).toBe("move task");
		expect(f.tmux("display-message", "-p", "-t", source, "#{session_name}")).toBe("Source");
		expect(await f.status()).toContain("Pending move repairs: windows 0, sessions 0");
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
			if (args[0] === "if-shell" || (sessionRenameTarget(args) && sessionRenameTarget(args) !== "%901")) {
				throw new Error("Synthetic transient failure");
			}
			return "";
		});
		const ctx = { mode: "tui", ui: { notify: (text: string) => warnings.push(text) } } as unknown as ExtensionContext;
		await handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx);
		const firstCalls = calls.length;
		await handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx);
		const secondCalls = calls.slice(firstCalls);
		expect(calls.filter((args) => args[0] === "set-option" && args[3] === "%901")).toHaveLength(8);
		expect(calls.filter((args) => args[0] === "display-message")).toHaveLength(18);
		expect(secondCalls.filter((args) => args[0] === "if-shell")).toHaveLength(32);
		expect(secondCalls.filter((args) => sessionRenameTarget(args) !== undefined && sessionRenameTarget(args) !== "%901")).toHaveLength(32);
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
		else process.env.PI_TMUX_MODEL = originalModel;
	}
});

test("tracked session metadata stays bounded when former-session repairs keep failing", async () => {
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	const originalHas = Set.prototype.has;
	const handlers = new Map<string, Function>();
	const checkedSizes: number[] = [];
	const commands: string[][] = [];
	let currentSession = 0;
	try {
		process.env.TMUX_PANE = "%901";
		process.env.PI_TMUX_MODEL = "off";
		Set.prototype.has = function (value) {
			if (typeof value === "string" && /^\$\d+$/.test(value)) checkedSizes.push(this.size);
			return originalHas.call(this, value);
		};
		piTmux({
			on: (event: string, handler: Function) => handlers.set(event, handler),
			registerCommand: () => {},
		} as unknown as ExtensionAPI, async (args) => {
			commands.push(args);
			if (args[0] === "display-message") return `\u0024${currentSession}:1:123\t@${currentSession}\t0\tcustom name`;
			if (args[0] === "rename-session" && /^\$\d+$/.test(args[2])) {
				throw new Error("Synthetic persistent former-session repair failure");
			}
			return "";
		});
		const ctx = { mode: "tui", ui: { notify: () => {} } } as unknown as ExtensionContext;
		for (currentSession = 1; currentSession <= 32; currentSession++) {
			await handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx);
		}

		expect(checkedSizes.length).toBeGreaterThan(0);
		// Eight queued former sessions plus the current session are the complete
		// set of session metadata that can still affect a future repair.
		expect(Math.max(...checkedSizes)).toBeLessThanOrEqual(9);

		// Returning to the oldest queued session before a new move must retain its
		// stored-base-name support when it becomes a former session again.
		commands.length = 0;
		currentSession = 24;
		await handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx);
		currentSession = 33;
		await handlers.get("session_start")!({ type: "session_start", reason: "reload" }, ctx);
		expect(commands.some((args) => args[0] === "set-option" && args[1] === "-F" && args[3] === "$24")).toBe(true);
		expect(Math.max(...checkedSizes)).toBeLessThanOrEqual(9);
	} finally {
		Set.prototype.has = originalHas;
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
		else process.env.PI_TMUX_MODEL = originalModel;
	}
});
