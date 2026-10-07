import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piTmux, { SESSION_TITLE_FORMAT, WAITING_OPTION, ACTIVE_OPTION, type RunTmux } from "../index";

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

const mockPi = (handlers: Map<string, Function>, commands?: Map<string, Function>) => ({
	on: (event: string, handler: Function) => handlers.set(event, handler),
	registerCommand: (name: string, command: { handler: Function }) => commands?.set(name, command.handler),
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

test.skipIf(!hasTmux).each([false, true])("window renames re-evaluate sibling status at execution time, initially waiting=%j", async (initialWaiting) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	try {
		process.env.PI_TMUX_MODEL = "off";
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Concurrent", "-n", "initial", "/bin/sleep 60");
		const sibling = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		tmux("set-option", "-p", "-t", sibling, WAITING_OPTION, initialWaiting ? "1" : "0");
		process.env.TMUX_PANE = pane;
		const handlers = new Map<string, Function>();
		const commands = new Map<string, Function>();
		let flip = true;
		piTmux(mockPi(handlers, commands), async (args) => {
			if (flip && args[0] === "rename-window") {
				flip = false;
				tmux("set-option", "-p", "-t", sibling, WAITING_OPTION, initialWaiting ? "0" : "1");
			}
			return tmux(...args);
		});
		const warnings: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (text: string, level: string) => { if (level === "warning") warnings.push(text); } } } as unknown as ExtensionContext;
		await commands.get("tmux-title")!("set " + "x".repeat(24), ctx);
		const title = tmux("display-message", "-p", "-t", pane, "#{window_name}");
		expect(title).toBe(initialWaiting ? "x".repeat(24) : "* " + "x".repeat(22));
		expect(title.length).toBe(24);
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});

test.skipIf(!hasTmux)("the real tmux adapter preserves empty window names", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const originalTmux = process.env.TMUX;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	try {
		process.env.PI_TMUX_MODEL = "off";
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "EmptyTitle", "/bin/sleep 60");
		tmux("rename-window", "-t", pane, "--", "");
		process.env.TMUX_PANE = pane;
		process.env.TMUX = tmux("display-message", "-p", "-t", pane, "#{socket_path},#{pid},0");
		const handlers = new Map<string, Function>();
		piTmux(mockPi(handlers));
		const warnings: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (text: string) => warnings.push(text) } } as unknown as ExtensionContext;
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		expect(tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("");
		expect(warnings).toEqual([]);
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("* pi");
		await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
		expect(tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("zsh");
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = originalTmux;
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});

test.skipIf(!hasTmux).each([false, true])("quitting one Pi preserves a live sibling's task title, sibling waiting=%j", async (waiting) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	try {
		process.env.PI_TMUX_MODEL = "off";
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Owners", "/bin/sleep 60");
		const sibling = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		const warnings: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (text: string, level: string) => { if (level === "warning") warnings.push(text); } } } as unknown as ExtensionContext;
		const peer = (target: string) => {
			const handlers = new Map<string, Function>();
			const commands = new Map<string, Function>();
			piTmux(mockPi(handlers, commands), async (args) => tmux(...args));
			return {
				emit: async (event: string) => {
					process.env.TMUX_PANE = target;
					await handlers.get(event)!({ type: event, reason: "quit" }, ctx);
					await new Promise<void>((resolve) => setImmediate(resolve));
				},
				pin: async (title: string) => {
					process.env.TMUX_PANE = target;
					await commands.get("tmux-title")!("set " + title, ctx);
				},
			};
		};
		const first = peer(pane);
		const second = peer(sibling);
		await first.emit("session_start");
		await second.emit("session_start");
		await first.pin("first task");
		await second.pin("peer task");
		if (waiting) await second.emit("agent_settled");
		await first.emit("session_shutdown");
		expect(tmux("display-message", "-p", "-t", sibling, "#{window_name}")).toBe(waiting ? "* peer task" : "peer task");
		expect(tmux("show-options", "-p", "-v", "-t", pane, ACTIVE_OPTION)).toBe("0");
		expect(tmux("show-options", "-p", "-v", "-t", sibling, ACTIVE_OPTION)).toBe("1");
		await second.emit("session_shutdown");
		expect(tmux("display-message", "-p", "-t", sibling, "#{window_name}")).toBe("zsh");
		expect(tmux("display-message", "-p", "-t", sibling, "#{session_name}")).toBe("Owners");
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});

test.skipIf(!hasTmux).each([
	{ activeAtExecution: false, waitingAtExecution: false },
	{ activeAtExecution: true, waitingAtExecution: false },
	{ activeAtExecution: true, waitingAtExecution: true },
])("quit re-evaluates ownership and preserves the latest literal title, status at execution=%j", async ({ activeAtExecution, waitingAtExecution }) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "");
	try {
		process.env.PI_TMUX_MODEL = "off";
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "LateOwner", "-n", "before", "/bin/sleep 60");
		const sibling = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		tmux("set-option", "-p", "-t", sibling, ACTIVE_OPTION, activeAtExecution ? "0" : "1");
		process.env.TMUX_PANE = pane;
		const handlers = new Map<string, Function>();
		let quitting = false;
		const latestTitle = "literal #{session_id}, Café\u2003-peer  ";
		piTmux(mockPi(handlers), async (args) => {
			if (quitting && args[0] === "rename-window") {
				quitting = false;
				tmux("set-option", "-p", "-t", sibling, ACTIVE_OPTION, activeAtExecution ? "1" : "0");
				tmux("set-option", "-p", "-t", sibling, WAITING_OPTION, waitingAtExecution ? "1" : "0");
				tmux("rename-window", "-t", sibling, "--", latestTitle.replaceAll("#", "##"));
			}
			return tmux(...args);
		});
		const warnings: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (text: string) => warnings.push(text) } } as unknown as ExtensionContext;
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		quitting = true;
		await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
		const expectedTitle = activeAtExecution ? (waitingAtExecution ? "* " + latestTitle.slice(0, 22) : latestTitle) : "zsh";
		expect(tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe(expectedTitle);
		expect(tmux("show-options", "-p", "-v", "-t", pane, ACTIVE_OPTION)).toBe("0");
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});

test.skipIf(!hasTmux)("window markers aggregate only their own waiting panes", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	try {
		process.env.PI_TMUX_MODEL = "off";
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Shared", "-n", "shared task", "/bin/sleep 60");
		const sibling = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		const session = tmux("display-message", "-p", "-t", pane, "#{session_id}");
		const otherWindow = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", session, "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		const handlers = new Map<string, Function>();
		piTmux(mockPi(handlers), async (args) => tmux(...args));
		const warnings: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (text: string) => warnings.push(text) } } as unknown as ExtensionContext;
		const emit = async (event: string) => {
			await handlers.get(event)!({ type: event, reason: "quit" }, ctx);
			// agent_start intentionally schedules its status write without awaiting it.
			await new Promise<void>((resolve) => setImmediate(resolve));
		};
		const title = () => tmux("display-message", "-p", "-t", pane, "#{window_name}");
		const sessionTitle = () => tmux("display-message", "-p", "-t", pane, "#{session_name}");

		tmux("set-option", "-p", "-t", sibling, WAITING_OPTION, "1");
		await emit("session_start");
		expect(title()).toBe("* shared task");
		await emit("agent_settled");
		await emit("agent_start");
		expect(title()).toBe("* shared task");
		expect(sessionTitle()).toBe("* Shared");
		await emit("session_shutdown");
		expect(title()).toBe("* shared task");
		expect(sessionTitle()).toBe("* Shared");

		tmux("set-option", "-p", "-t", sibling, WAITING_OPTION, "0");
		tmux("set-option", "-p", "-t", otherWindow, WAITING_OPTION, "1");
		await emit("agent_start");
		expect(title()).toBe("zsh");
		expect(sessionTitle()).toBe("* Shared");
		tmux("set-option", "-p", "-t", otherWindow, WAITING_OPTION, "0");
		await emit("agent_start");
		expect(title()).toBe("zsh");
		expect(sessionTitle()).toBe("Shared");
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
	}).replace(/\r?\n$/, "");
	try {
		const name = "My\u2003Café Session " + "X".repeat(40) + " #{session_id}  ";
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
