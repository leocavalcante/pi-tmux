import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piTmux, { SESSION_TITLE_FORMAT, WAITING_OPTION, ACTIVE_OPTION, type RunTmux } from "../index";
import { supportsUnixTmux } from "./tmux-support.ts";

const hasTmux = supportsUnixTmux(process.platform, Bun.which("tmux"));
const hasRoundTripUnsafeWindowNames = (() => {
	if (!hasTmux) return false;
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-probe-"));
	const socket = join(directory, "socket");
	const run = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		run("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Probe", "-n", "probe\tline\n", "/bin/sleep 60");
		return true;
	} catch {
		return false;
	} finally {
		try { run("kill-server"); } catch { /* The server may not have started. */ }
		rmSync(directory, { recursive: true, force: true });
	}
})();
let originalModel: string | undefined;
let originalIdleTitle: string | undefined;
beforeEach(() => {
	originalModel = process.env.PI_TMUX_MODEL;
	originalIdleTitle = process.env.PI_TMUX_IDLE_TITLE;
	delete process.env.PI_TMUX_MODEL;
	delete process.env.PI_TMUX_IDLE_TITLE;
});
afterEach(() => {
	if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
	else process.env.PI_TMUX_MODEL = originalModel;
	if (originalIdleTitle === undefined) delete process.env.PI_TMUX_IDLE_TITLE;
	else process.env.PI_TMUX_IDLE_TITLE = originalIdleTitle;
});

const mockPi = (handlers: Map<string, Function>, commands?: Map<string, Function>) => ({
	on: (event: string, handler: Function) => handlers.set(event, handler),
	registerCommand: (name: string, command: { handler: Function }) => commands?.set(name, command.handler),
}) as unknown as ExtensionAPI;

function observedCommand(args: string[]): string[] {
	if (args[0] !== "if-shell" || args[1] !== "-F" || !/^#\{==:#\{pid\},\d+\}$/.test(args[2])) return args;
	const result: string[] = [];
	const command = args[3];
	for (let index = 0; index < command.length;) {
		while (/\s/.test(command[index] ?? "")) index++;
		if (index >= command.length) break;
		if (command[index] === ";") { result.push(";"); index++; continue; }
		expect(command[index]).toBe('"');
		index++;
		let value = "";
		while (index < command.length && command[index] !== '"') {
			if (command[index] === "\\") index++;
			value += command[index++];
		}
		expect(command[index]).toBe('"');
		index++;
		result.push(value);
	}
	return result;
}

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
	}).replace(/\r?\n$/, "");
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
	}).replace(/\r?\n$/, "");
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

test.skipIf(!hasTmux)("waiting markers preserve literal custom window names without a task title", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "");
	try {
		process.env.PI_TMUX_MODEL = "off";
		const requestedTitle = `Custom API #{session_id}, \"Deploy\" ${"X".repeat(30)}  `;
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "CustomWindow", "-n", requestedTitle.replaceAll("#", "##"), "/bin/sleep 60");
		const customTitle = tmux("display-message", "-p", "-t", pane, "#{window_name}");
		process.env.TMUX_PANE = pane;
		const handlers = new Map<string, Function>();
		const warnings: string[] = [];
		piTmux(mockPi(handlers), async (args) => tmux(...args));
		const ctx = {
			mode: "tui",
			sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
			ui: { notify: (text: string) => warnings.push(text) },
		} as unknown as ExtensionContext;
		const windowTitle = () => tmux("display-message", "-p", "-t", pane, "#{window_name}");
		const waitForTitle = async (expected: string) => {
			for (let i = 0; i < 50; i++) {
				if (windowTitle() === expected) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`Window title did not become ${JSON.stringify(expected)}; got ${JSON.stringify(windowTitle())}`);
		};

		expect(windowTitle()).toBe(customTitle);
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		await waitForTitle(`* ${customTitle}`);
		expect(tmux("show-options", "-p", "-v", "-t", pane, WAITING_OPTION)).toBe("1");
		handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await waitForTitle(customTitle);
		expect(tmux("show-options", "-p", "-v", "-t", pane, WAITING_OPTION)).toBe("0");
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
		else process.env.PI_TMUX_MODEL = originalModel;
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});

test.skipIf(!hasTmux)("quit preserves a literal leading prefix when legacy window metadata is absent", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "");
	try {
		process.env.PI_TMUX_MODEL = "off";
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "LegacyPrefix", "-n", "* Custom window", "/bin/sleep 60");
		const window = tmux("display-message", "-p", "-t", pane, "#{window_id}");
		const peer = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		tmux("set-option", "-p", "-t", peer, ACTIVE_OPTION, "1");
		process.env.TMUX_PANE = pane;
		const handlers = new Map<string, Function>();
		const run: RunTmux = Object.assign(async (args: string[]) => tmux(...args), { supportsServerPidGuard: true });
		piTmux(mockPi(handlers), run);
		const warnings: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (text: string) => warnings.push(text) } } as unknown as ExtensionContext;
		const windowTitle = () => tmux("display-message", "-p", "-t", pane, "#{window_name}");

		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		expect(windowTitle()).toBe("* Custom window");
		expect(tmux("show-options", "-w", "-v", "-t", window, "@pi-tmux-window-title-marked")).toBe("unmarked");
		for (const option of ["@pi-tmux-window-base-name", "@pi-tmux-window-title-marked", "@pi-tmux-window-literal-prefix"]) {
			tmux("set-option", "-w", "-u", "-t", window, option);
		}
		tmux("set-option", "-p", "-t", peer, WAITING_OPTION, "1");

		await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
		expect(windowTitle()).toBe("* * Custom window");
		expect(tmux("show-options", "-p", "-v", "-t", peer, ACTIVE_OPTION)).toBe("1");
		expect(tmux("show-options", "-p", "-v", "-t", peer, WAITING_OPTION)).toBe("1");
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
		else process.env.PI_TMUX_MODEL = originalModel;
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});

test.skipIf(!hasTmux)("literal leading waiting prefixes survive startup and shared-pane status transitions", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "");
	try {
		process.env.PI_TMUX_MODEL = "off";
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "LiteralPrefix", "-n", "* Custom window", "/bin/sleep 60");
		const window = tmux("display-message", "-p", "-t", pane, "#{window_id}");
		tmux("set-window-option", "-t", window, "automatic-rename-format", "* Custom window");
		tmux("set-window-option", "-t", window, "automatic-rename", "on");
		const sibling = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		const handlers = new Map<string, Function>();
		const run: RunTmux = Object.assign(async (args: string[]) => tmux(...args), { supportsServerPidGuard: true });
		piTmux(mockPi(handlers), run);
		const warnings: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (text: string) => warnings.push(text) } } as unknown as ExtensionContext;
		const windowTitle = () => tmux("display-message", "-p", "-t", pane, "#{window_name}");
		const waitForTitle = async (expected: string) => {
			for (let i = 0; i < 50; i++) {
				if (windowTitle() === expected) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`Window title did not become ${JSON.stringify(expected)}; got ${JSON.stringify(windowTitle())}`);
		};

		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		expect(windowTitle()).toBe("* Custom window");
		expect(tmux("show-options", "-w", "-v", "-t", window, "@pi-tmux-window-title-marked")).toBe("unmarked");
		expect(tmux("show-options", "-w", "-v", "-t", window, "@pi-tmux-window-literal-prefix")).toBe("1");
		expect(tmux("show-window-options", "-v", "-t", window, "automatic-rename")).toBe("on");

		tmux("set-option", "-p", "-t", sibling, WAITING_OPTION, "1");
		handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await waitForTitle("* * Custom window");
		tmux("set-option", "-p", "-t", sibling, WAITING_OPTION, "0");
		handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await waitForTitle("* Custom window");

		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		await waitForTitle("* * Custom window");
		handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await waitForTitle("* Custom window");
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
		else process.env.PI_TMUX_MODEL = originalModel;
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});

test.skipIf(!hasTmux)("literal leading prefixes survive move repair and peer-aware quit cleanup", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "");
	try {
		process.env.PI_TMUX_MODEL = "off";
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "PrefixSource", "-n", "* Custom window", "/bin/sleep 60");
		const sourceWindow = tmux("display-message", "-p", "-t", pane, "#{window_id}");
		const anchor = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		tmux("set-option", "-p", "-t", anchor, WAITING_OPTION, "1");
		const destinationPane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "PrefixDestination", "-n", "* Custom window", "/bin/sleep 60");
		const destinationWindow = tmux("display-message", "-p", "-t", destinationPane, "#{window_id}");
		tmux("set-window-option", "-t", destinationWindow, "automatic-rename-format", "* Custom window");
		tmux("set-window-option", "-t", destinationWindow, "automatic-rename", "on");
		const peer = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", destinationPane, "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		const handlers = new Map<string, Function>();
		const run: RunTmux = Object.assign(async (args: string[]) => tmux(...args), { supportsServerPidGuard: true });
		piTmux(mockPi(handlers), run);
		const warnings: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (text: string) => warnings.push(text) } } as unknown as ExtensionContext;
		const title = (target: string) => tmux("display-message", "-p", "-t", target, "#{window_name}");
		const waitForTitle = async (target: string, expected: string) => {
			for (let i = 0; i < 50; i++) {
				if (title(target) === expected) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`Window ${target} did not become ${JSON.stringify(expected)}; got ${JSON.stringify(title(target))}`);
		};
		const waitForOption = async (target: string, option: string, expected: string) => {
			for (let i = 0; i < 50; i++) {
				try {
					if (tmux("show-options", "-w", "-v", "-t", target, option) === expected) return;
				} catch { /* the user option may not have been created yet */ }
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`Window option ${option} on ${target} did not become ${JSON.stringify(expected)}`);
		};

		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		await waitForTitle(pane, "* * Custom window");
		tmux("set-option", "-p", "-t", anchor, WAITING_OPTION, "0");
		tmux("set-option", "-p", "-t", peer, ACTIVE_OPTION, "1");
		tmux("join-pane", "-d", "-s", pane, "-t", destinationPane);
		handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await waitForTitle(anchor, "* Custom window");
		await waitForTitle(pane, "* Custom window");
		await waitForOption(destinationWindow, "@pi-tmux-window-title-marked", "unmarked");
		expect(tmux("show-options", "-w", "-v", "-t", destinationWindow, "@pi-tmux-window-title-marked")).toBe("unmarked");
		expect(tmux("display-message", "-p", "-t", pane, "#{window_id}")).toBe(destinationWindow);

		tmux("set-option", "-p", "-t", peer, WAITING_OPTION, "1");
		await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
		expect(title(pane)).toBe("* * Custom window");
		expect(tmux("show-options", "-p", "-v", "-t", peer, ACTIVE_OPTION)).toBe("1");
		tmux("set-option", "-p", "-t", peer, ACTIVE_OPTION, "0");
		tmux("set-option", "-p", "-t", peer, WAITING_OPTION, "0");
		await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
		expect(title(pane)).toBe("zsh");
		expect(title(anchor)).toBe("* Custom window");
		expect(tmux("display-message", "-p", "-t", sourceWindow, "#{session_name}")).toBe("PrefixSource");
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
		else process.env.PI_TMUX_MODEL = originalModel;
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});

test.skipIf(!hasTmux).each([false, true])("window renames re-evaluate sibling status at execution time, initially waiting=%j", async (initialWaiting) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "");
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
			if (flip && observedCommand(args)[0] === "rename-window") {
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
	}).replace(/\r?\n$/, "");
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
		const title = () => tmux("display-message", "-p", "-t", pane, "#{window_name}");
		const waitForTitle = async (expected: string) => {
			for (let i = 0; i < 50; i++) {
				if (title() === expected) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`Window title did not become ${JSON.stringify(expected)}; got ${JSON.stringify(title())}`);
		};
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		expect(title()).toBe("");
		expect(warnings).toEqual([]);
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		await waitForTitle("* pi");
		handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		await waitForTitle("");
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		await waitForTitle("* pi");
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

test.skipIf(!hasTmux)("the real tmux adapter handles long custom window names", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const originalTmux = process.env.TMUX;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "");
	try {
		process.env.PI_TMUX_MODEL = "off";
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "LongTitle", "/bin/sleep 60");
		const title = "x".repeat(8_000);
		tmux("rename-window", "-t", pane, "--", title);
		process.env.TMUX_PANE = pane;
		process.env.TMUX = tmux("display-message", "-p", "-t", pane, "#{socket_path},#{pid},0");
		const handlers = new Map<string, Function>();
		piTmux(mockPi(handlers));
		const warnings: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (text: string) => warnings.push(text) } } as unknown as ExtensionContext;
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		expect(warnings).toEqual([]);
		expect(tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe(title);
		expect(tmux("show-options", "-p", "-v", "-t", pane, ACTIVE_OPTION)).toBe("1");
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = originalTmux;
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});

test.skipIf(!hasTmux).each([false, true])("quitting one Pi preserves its peer's title and uses the configured idle title when last, peer waiting=%j", async (waiting) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "");
	try {
		process.env.PI_TMUX_MODEL = "off";
		process.env.PI_TMUX_IDLE_TITLE = "Fish & Shell";
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
		// The surviving owner's literal title must survive quit cleanup byte-for-byte.
		tmux("rename-window", "-t", sibling, "--", "peer task  ");
		await first.emit("session_shutdown");
		expect(tmux("display-message", "-p", "-t", sibling, "#{window_name}")).toBe(waiting ? "* peer task  " : "peer task  ");
		expect(tmux("show-options", "-p", "-v", "-t", pane, ACTIVE_OPTION)).toBe("0");
		expect(tmux("show-options", "-p", "-v", "-t", sibling, ACTIVE_OPTION)).toBe("1");
		await second.emit("session_shutdown");
		expect(tmux("display-message", "-p", "-t", sibling, "#{window_name}")).toBe("fish shell");
		expect(tmux("display-message", "-p", "-t", sibling, "#{session_name}")).toBe("Owners");
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});

test.skipIf(!hasTmux)("malformed active flags do not prevent quit cleanup", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "");
	try {
		process.env.PI_TMUX_MODEL = "off";
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "BadFlag", "-n", "existing task", "/bin/sleep 60");
		const sibling = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane, "/bin/sleep 60");
		tmux("set-option", "-p", "-t", sibling, ACTIVE_OPTION, "10");
		process.env.TMUX_PANE = pane;
		const handlers = new Map<string, Function>();
		piTmux(mockPi(handlers), async (args) => tmux(...args));
		const warnings: string[] = [];
		const ctx = { mode: "tui", ui: { notify: (text: string) => warnings.push(text) } } as unknown as ExtensionContext;
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
		expect(tmux("display-message", "-p", "-t", pane, "#{window_name}")).toBe("zsh");
		expect(tmux("show-options", "-p", "-v", "-t", sibling, ACTIVE_OPTION)).toBe("10");
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
])("quit re-evaluates ownership and preserves the latest literal title without truncation, status at execution=%j", async ({ activeAtExecution, waitingAtExecution }) => {
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
		expect(latestTitle.length).toBeGreaterThan(22);
		piTmux(mockPi(handlers), async (args) => {
			if (quitting && observedCommand(args)[0] === "rename-window") {
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
		const expectedTitle = activeAtExecution ? (waitingAtExecution ? "* " + latestTitle : latestTitle) : "zsh";
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
	}).replace(/\r?\n$/, "");
	try {
		process.env.PI_TMUX_MODEL = "off";
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "* Important", "-n", "shared task", "/bin/sleep 60");
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

		await emit("session_start");
		expect(title()).toBe("shared task");
		expect(sessionTitle()).toBe("* Important");
		tmux("set-option", "-p", "-t", sibling, WAITING_OPTION, "1");
		await emit("agent_start");
		expect(title()).toBe("* shared task");
		expect(sessionTitle()).toBe("* * Important");
		await emit("agent_settled");
		await emit("agent_start");
		expect(title()).toBe("* shared task");
		expect(sessionTitle()).toBe("* * Important");
		tmux("set-option", "-p", "-t", sibling, WAITING_OPTION, "0");
		await emit("agent_start");
		expect(sessionTitle()).toBe("* Important");
		tmux("set-option", "-p", "-t", sibling, WAITING_OPTION, "1");
		await emit("agent_start");
		expect(sessionTitle()).toBe("* * Important");
		tmux("rename-session", "-t", pane, "--", "* Renamed");
		await emit("agent_start");
		expect(sessionTitle()).toBe("* * Renamed");
		await emit("session_shutdown");
		expect(title()).toBe("* shared task");
		expect(sessionTitle()).toBe("* * Renamed");

		tmux("set-option", "-p", "-t", sibling, WAITING_OPTION, "0");
		tmux("set-option", "-p", "-t", otherWindow, WAITING_OPTION, "1");
		await emit("agent_start");
		expect(title()).toBe("zsh");
		expect(sessionTitle()).toBe("* * Renamed");
		tmux("set-option", "-p", "-t", otherWindow, WAITING_OPTION, "0");
		await emit("agent_start");
		expect(title()).toBe("zsh");
		expect(sessionTitle()).toBe("* Renamed");

		// Even a manual name that looks exactly like a marker of the prior base
		// is literal while the recorded session state is unmarked.
		tmux("rename-session", "-t", pane, "--", "* * Renamed");
		await emit("agent_start");
		expect(sessionTitle()).toBe("* * Renamed");
		expect(tmux("show-options", "-v", "-t", pane, "@pi-tmux-session-base-name")).toBe("* * Renamed");
		tmux("set-option", "-p", "-t", sibling, WAITING_OPTION, "1");
		await emit("agent_start");
		expect(sessionTitle()).toBe("* * * Renamed");
		tmux("set-option", "-p", "-t", sibling, WAITING_OPTION, "0");
		await emit("agent_start");
		expect(sessionTitle()).toBe("* * Renamed");
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

test.skipIf(!hasTmux)("server-guarded waiting updates preserve session names with tmux punctuation", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "");
	try {
		process.env.PI_TMUX_MODEL = "off";
		const name = `Repo; "quoted" \\ path #{session_id}`;
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name.replaceAll("#", "##"), "-n", "initial", "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		const handlers = new Map<string, Function>();
		const run: RunTmux = Object.assign(async (args: string[]) => tmux(...args), { supportsServerPidGuard: true });
		piTmux(mockPi(handlers), run);
		const warnings: string[] = [];
		const ctx = {
			mode: "tui",
			sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
			ui: { notify: (text: string) => warnings.push(text) },
		} as unknown as ExtensionContext;
		const emit = async (event: string) => {
			await handlers.get(event)!({ type: event, reason: "quit" }, ctx);
			// agent_start intentionally schedules its status write without awaiting it.
			await new Promise<void>((resolve) => setImmediate(resolve));
		};
		const sessionName = () => tmux("display-message", "-p", "-t", pane, "#{session_name}");
		const initialName = sessionName();
		expect(initialName).toContain("Repo; \"quoted\"");
		expect(initialName).toContain("\\");
		expect(initialName).toContain("#{session_id}");

		await emit("session_start");
		expect(sessionName()).toBe(initialName);
		await emit("agent_settled");
		expect(sessionName()).toBe(`* ${initialName}`);
		await emit("agent_start");
		expect(sessionName()).toBe(initialName);
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
		else process.env.PI_TMUX_MODEL = originalModel;
		try { tmux("kill-server"); } finally { rmSync(directory, { recursive: true, force: true }); }
	}
});

test.skipIf(!hasTmux || !hasRoundTripUnsafeWindowNames)("server-guarded waiting updates preserve tabs and newlines in custom window names", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	const socket = join(directory, "socket");
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
		encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "");
	try {
		process.env.PI_TMUX_MODEL = "off";
		const customTitle = "custom\tline\n";
		const pane = tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "Newline", "-n", customTitle, "/bin/sleep 60");
		process.env.TMUX_PANE = pane;
		const handlers = new Map<string, Function>();
		const run: RunTmux = Object.assign(async (args: string[]) => tmux(...args), { supportsServerPidGuard: true });
		piTmux(mockPi(handlers), run);
		const warnings: string[] = [];
		const ctx = {
			mode: "tui",
			sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
			ui: { notify: (text: string) => warnings.push(text) },
		} as unknown as ExtensionContext;
		const emit = async (event: string) => {
			await handlers.get(event)!({ type: event, reason: "quit" }, ctx);
			// agent_start intentionally schedules its status write without awaiting it.
			await new Promise<void>((resolve) => setImmediate(resolve));
		};
		const title = () => tmux("display-message", "-p", "-t", pane, "#{window_name}");
		const sessionName = () => tmux("display-message", "-p", "-t", pane, "#{session_name}");

		expect(title()).toBe(customTitle);
		await emit("session_start");
		expect(title()).toBe(customTitle);
		await emit("agent_settled");
		expect(title()).toBe(customTitle);
		expect(sessionName()).toBe("* Newline");
		await emit("agent_start");
		expect(title()).toBe(customTitle);
		expect(sessionName()).toBe("Newline");
		expect(warnings).toEqual([
			"A custom window name contains a tab or line feed; its waiting marker was skipped.",
		]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
		else process.env.PI_TMUX_MODEL = originalModel;
		try { tmux("kill-server"); } catch { /* The server may not have started if setup failed. */ }
		rmSync(directory, { recursive: true, force: true });
	}
});
