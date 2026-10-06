import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piTmux, { buildNamingContext, buildWindowTitleFormat, WINDOW_INFO_FORMAT, WINDOW_WAITING_FORMAT, cleanTitle, formatTitle, parseNamingModel, MAX_CONTEXT_LENGTH, MAX_HISTORY_MESSAGES, MAX_PROMPT_LENGTH, MAX_TITLE_LENGTH, READY_PREFIX, SESSION_TITLE_FORMAT, WAITING_OPTION, ACTIVE_OPTION, QUIT_TITLE_FORMAT, type RunTmux } from "../index";

let originalPane: string | undefined;
let originalModel: string | undefined;
beforeEach(() => {
	originalPane = process.env.TMUX_PANE;
	originalModel = process.env.PI_TMUX_MODEL;
	process.env.TMUX_PANE = "%1";
	delete process.env.PI_TMUX_MODEL;
});
afterEach(() => {
	if (originalPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = originalPane;
	if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
	else process.env.PI_TMUX_MODEL = originalModel;
});

const response = (text: string, stopReason = "stop") => ({
	content: [{ type: "text", text }],
	stopReason,
});

function fixture(
	results: Promise<ReturnType<typeof response>>[] = [Promise.resolve(response("Fix auth tests"))],
	beforeCommand?: (args: string[], signal: AbortSignal, renderedTitle?: string) => Promise<void>,
) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	const notices: string[] = [];
	const calls: string[][] = [];
	const writes: string[] = [];
	const requests: { model: unknown; context: any; options: any }[] = [];
	const warnings: string[] = [];
	const messages: any[] = [];
	const ctx = {
		mode: "tui",
		sessionManager: { buildSessionProjection: () => ({ messages }) },
		ui: { notify: (text: string, level: string) => (level === "warning" ? warnings : notices).push(text) },
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
			streamSimple: (model: unknown, context: unknown, options: unknown) => {
				requests.push({ model, context, options });
				return { result: () => results.shift()! };
			},
		},
	} as unknown as ExtensionContext;
	const state = {
		window: "@2", title: "existing task", session: "$0", sessionTitle: "My Session",
		waitingPanes: new Map<string, string>(),
		activePanes: new Map<string, string>(),
		otherWindowPanes: new Set<string>(),
	};
	const windowWaiting = () => [...state.waitingPanes].some(([pane, value]) => value === "1" && !state.otherWindowPanes.has(pane));
	const renderTitle = (format: string) => {
		if (format === QUIT_TITLE_FORMAT) {
			const hasPeer = [...state.activePanes, ...state.waitingPanes].some(([pane, value]) => value === "1" && !state.otherWindowPanes.has(pane));
			if (!hasPeer) return formatTitle("zsh", windowWaiting());
			const title = state.title.replace(/^\* /, "");
			return windowWaiting() ? READY_PREFIX + title.slice(0, 22) : title;
		}
		const prefix = `#{?${WINDOW_WAITING_FORMAT},`;
		expect(format).toStartWith(prefix);
		expect(format).toEndWith("}");
		const [ready, busy] = format.slice(prefix.length, -1).split(",");
		return windowWaiting() ? ready : busy;
	};
	const tmux: RunTmux = async (args, signal) => {
		calls.push(args);
		if (beforeCommand) await beforeCommand(args, signal, args[0] === "rename-window" ? renderTitle(args[4]) : undefined);
		if (args[0] === "display-message") return `${state.session}\t${state.window}\t${windowWaiting() ? "1" : "0"}\t${state.title}`;
		if (args[0] === "set-option") {
			expect(args).toEqual([
				"set-option", "-p", "-t", "%1", WAITING_OPTION, args[5],
				";", "set-option", "-p", "-t", "%1", ACTIVE_OPTION, args[12],
				";", "rename-session", "-t", "%1", SESSION_TITLE_FORMAT,
			]);
			state.waitingPanes.set(args[3], args[5]);
			state.activePanes.set(args[10], args[12]);
			const anyWaiting = [...state.waitingPanes.values()].includes("1");
			state.sessionTitle = (anyWaiting ? READY_PREFIX : "") + state.sessionTitle.replace(/^\* /, "");
		}
		if (args[0] === "rename-window") {
			expect(args.slice(0, 4)).toEqual(["rename-window", "-t", "%1", "--"]);
			state.title = renderTitle(args[4]);
			writes.push(state.title);
		}
		return "";
	};
	const load = () => piTmux({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command),
	} as unknown as ExtensionAPI, tmux);
	load();
	const input = (text: string, source = "interactive") => handlers.get("input")!({ text, source }, ctx);
	const emit = (event: string, reason = event === "session_shutdown" ? "quit" : "startup") =>
		handlers.get(event)?.({ type: event, reason }, ctx);
	return { handlers, calls, writes, requests, warnings, notices, messages, ctx, input, emit, state, load,
		refresh: (args = "") => commands.get("tmux-title")!.handler(args, ctx),
	};
}

async function settle() {
	for (let i = 0; i < 40; i++) await Promise.resolve();
}

const renameCommand = (title: string) => ["rename-window", "-t", "%1", "--", buildWindowTitleFormat(title)];
const quitCommand = () => ["rename-window", "-t", "%1", "--", QUIT_TITLE_FORMAT];

function deferred() {
	let resolve!: (result: ReturnType<typeof response>) => void;
	const promise = new Promise<ReturnType<typeof response>>((done) => { resolve = done; });
	return { promise, resolve };
}

test("cleans markup, accents, controls, and tmux formatting characters", () => {
	expect(cleanTitle('"Fix café\n# auth"\u001b')).toBe("fix cafe auth");
	expect(cleanTitle("Fix auth tests")).toBe("fix auth tests");
	expect(cleanTitle("FIX API Titles")).toBe("fix api titles");
	expect(cleanTitle("#[]\n\u001b")).toBe("");
	expect(cleanTitle("---")).toBe("");
});

test("caps names at 24 ASCII cells, preferably on a word boundary", () => {
	expect(cleanTitle("Investigate authentication failures")).toBe("investigate");
	expect(cleanTitle("x".repeat(80))).toHaveLength(MAX_TITLE_LENGTH);
	expect(cleanTitle("x".repeat(24))).toHaveLength(MAX_TITLE_LENGTH);
});

test("passes input through immediately and renames the owning window", async () => {
	const f = fixture();
	expect(f.input("Fix the failing authentication tests")).toEqual({ action: "continue" });
	expect(f.calls).toEqual([]);
	await settle();
	expect(f.requests[0].model).toEqual({ provider: "openai-codex", id: "gpt-6-luna" });
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([
		renameCommand("fix auth tests"),
	]);
	expect(f.calls[0]).toEqual(["display-message", "-p", "-t", "%1", WINDOW_INFO_FORMAT]);
	expect(f.warnings).toEqual([]);
});

test.each(["-fix auth", "-t", "-a"])("model title %s is passed as a literal tmux argument", async (title) => {
	const f = fixture([Promise.resolve(response(title))]);
	f.input("Synthetic task");
	await settle();
	expect(f.state.title).toBe(title);
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([
		renameCommand(title),
	]);
	expect(f.warnings).toEqual([]);
});

test("bounds prompt and output and disables reasoning and retries", async () => {
	const f = fixture();
	f.input("x".repeat(10_000));
	await settle();
	const request = f.requests[0];
	expect(request.context.messages).toHaveLength(1);
	expect(request.context.messages[0].content).toBe("user: " + "x".repeat(MAX_PROMPT_LENGTH));
	expect(request.options).toMatchObject({ maxTokens: 96, reasoning: undefined, maxRetries: 0, cacheRetention: "none" });
});

test("ignores print/RPC, injected messages, empty input, and non-tmux sessions", async () => {
	const f = fixture();
	f.input("", "interactive");
	f.input("Injected task", "extension");
	f.input("RPC task", "rpc");
	(f.ctx as any).mode = "text";
	f.input("Print task");
	(f.ctx as any).mode = "tui";
	delete process.env.TMUX_PANE;
	f.input("No tmux");
	process.env.TMUX_PANE = "bad-target";
	f.input("Invalid pane");
	await settle();
	expect(f.requests).toEqual([]);
	expect(f.calls).toEqual([]);
});

test("superseding input aborts old work and an old result cannot overwrite the new title", async () => {
	const old = deferred();
	const f = fixture([old.promise, Promise.resolve(response("New task"))]);
	f.input("Old task");
	f.input("New task");
	expect(f.requests[0].options.signal.aborted).toBe(true);
	await settle();
	old.resolve(response("Old task"));
	await settle();
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([renameCommand("new task")]);
});

test("shutdown and session replacement cancel outstanding naming", async () => {
	for (const event of ["session_shutdown", "session_start"]) {
		const work = deferred();
		const f = fixture([work.promise]);
		f.input("Task");
		await f.emit(event);
		expect(f.requests[0].options.signal.aborted).toBe(true);
		work.resolve(response("Late title"));
		await settle();
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual(
			event === "session_shutdown" ? [quitCommand()] : [],
		);
	}
});

test("missing model leaves the name alone and warns only once", async () => {
	const f = fixture();
	(f.ctx.modelRegistry as any).find = () => undefined;
	f.input("First task");
	await settle();
	f.input("Second task");
	await settle();
	expect(f.requests).toEqual([]);
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(f.warnings).toHaveLength(1);
});

test("empty or failed responses never become window names", async () => {
	for (const result of [response(""), response("---"), response("Error details", "error")]) {
		const f = fixture([Promise.resolve(result)]);
		f.input("Task");
		await settle();
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toHaveLength(1);
	}
});

test("ready marker fits within 24 cells and title text stays lowercase", () => {
	expect(formatTitle("FIX API Tests", true)).toBe("* fix api tests");
	expect(formatTitle("X".repeat(24), true)).toBe("* " + "x".repeat(22));
	expect(formatTitle("X".repeat(24), false)).toBe("x".repeat(24));
	expect(formatTitle("", true)).toBe("* pi");
});

test("window formats contain two sanitized, capped branches", () => {
	expect(buildWindowTitleFormat("x".repeat(30))).toBe(`#{?${WINDOW_WAITING_FORMAT},* ${"x".repeat(22)},${"x".repeat(24)}}`);
	expect(buildWindowTitleFormat("#[] ---")).toBe(`#{?${WINDOW_WAITING_FORMAT},* pi,pi}`);
	expect(buildWindowTitleFormat("Fix café #{session_id}, auth")).not.toContain("#{session_id}");
});

test("late model output preserves another pane's waiting marker", async () => {
	const work = deferred();
	const f = fixture([work.promise]);
	f.state.waitingPanes.set("%2", "1");
	f.input("Task");
	await settle();
	expect(f.state.title).toBe("* existing task");
	work.resolve(response("new task"));
	await settle();
	expect(f.state.title).toBe("* new task");
	expect(f.state.waitingPanes.get("%1")).toBe("0");
	expect(f.requests).toHaveLength(1);
});

test("waiting panes in another window mark the session but not this window", async () => {
	const f = fixture([]);
	f.state.waitingPanes.set("%2", "1");
	f.state.otherWindowPanes.add("%2");
	await f.emit("session_start");
	expect(f.state.title).toBe("existing task");
	expect(f.state.sessionTitle).toBe("* My Session");
	await f.emit("agent_settled");
	expect(f.state.title).toBe("* existing task");
	f.emit("agent_start");
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.state.sessionTitle).toBe("* My Session");
});

test("only final settlement marks waiting, without another model call", async () => {
	const f = fixture();
	f.input("Task");
	await settle();
	f.emit("turn_end");
	f.emit("agent_end");
	await settle();
	expect(f.state.title).toBe("fix auth tests");
	await f.emit("agent_settled");
	expect(f.state.title).toBe("* fix auth tests");
	expect(f.state.sessionTitle).toBe("* My Session");
	expect(f.requests).toHaveLength(1);
	const writes = f.calls.filter((args) => args[0] === "rename-window").length;
	await f.emit("agent_settled");
	expect(f.state.title).toBe("* fix auth tests");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toHaveLength(writes);
});

test("new input clears the marker before its slow summary arrives", async () => {
	const next = deferred();
	const f = fixture([Promise.resolve(response("Fix auth tests")), next.promise]);
	f.input("First task");
	await settle();
	await f.emit("agent_settled");
	f.input("Next task");
	await settle();
	expect(f.state.title).toBe("fix auth tests");
	expect(f.state.sessionTitle).toBe("My Session");
	next.resolve(response("New task"));
	await settle();
	expect(f.state.title).toBe("new task");
});

test("internally started work clears the marker without a new naming request", async () => {
	const f = fixture();
	f.input("Task");
	await settle();
	await f.emit("agent_settled");
	f.emit("agent_start");
	await settle();
	expect(f.state.title).toBe("fix auth tests");
	expect(f.state.sessionTitle).toBe("My Session");
	expect(f.requests).toHaveLength(1);
});

test("late naming result retains the settled marker", async () => {
	const work = deferred();
	const f = fixture([work.promise]);
	f.input("Task");
	// Pi persists the submitted prompt before the run settles.
	f.messages.push({ role: "user", content: "Task" });
	await f.emit("agent_settled");
	expect(f.requests[0].options.signal.aborted).toBe(false);
	expect(f.requests).toHaveLength(1);
	expect(f.state.title).toBe("* existing task");
	work.resolve(response("Fix auth tests"));
	await settle();
	expect(f.state.title).toBe("* fix auth tests");
});

test("waiting status still works when the naming model is unavailable", async () => {
	const f = fixture();
	(f.ctx.modelRegistry as any).find = () => undefined;
	f.input("Task");
	await settle();
	await f.emit("agent_settled");
	expect(f.state.title).toBe("* existing task");
	expect(f.requests).toHaveLength(0);
});

test("session replacement clears the marker and shutdown resets the title", async () => {
	for (const event of ["session_start", "session_shutdown"]) {
		const f = fixture();
		f.input("Task");
		await settle();
		await f.emit("agent_settled");
		await f.emit(event);
		expect(f.state.title).toBe(event === "session_shutdown" ? "zsh" : "fix auth tests");
		expect(f.state.sessionTitle).toBe("My Session");
		expect(f.state.waitingPanes.get("%1")).toBe("0");
	}
});

test("reload preserves the task title across fresh extension runtimes, then quit resets it", async () => {
	for (const waiting of [false, true]) {
		const f = fixture();
		f.input("Task");
		await settle();
		if (waiting) await f.emit("agent_settled");
		await f.emit("session_shutdown", "reload");
		f.load();
		await f.emit("session_start", "reload");
		expect(f.state.title).toBe("fix auth tests");
		expect(f.state.sessionTitle).toBe("My Session");
		expect(f.calls.filter((args) => args[0] === "rename-window" && args[4] === QUIT_TITLE_FORMAT)).toEqual([]);
		expect(f.requests).toHaveLength(1);
		await f.emit("session_shutdown", "quit");
		expect(f.state.title).toBe("zsh");
	}
});

test("reload cancels pending naming without resetting the existing task title", async () => {
	const work = deferred();
	const f = fixture([work.promise]);
	f.input("Task");
	await settle();
	await f.emit("session_shutdown", "reload");
	expect(f.requests[0].options.signal.aborted).toBe(true);
	f.load();
	await f.emit("session_start", "reload");
	work.resolve(response("Late title"));
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
});

test("session replacement teardown preserves the title and clears waiting", async () => {
	for (const reason of ["new", "resume", "fork"]) {
		const f = fixture();
		f.input("Task");
		await settle();
		await f.emit("agent_settled");
		await f.emit("session_shutdown", reason);
		expect(f.state.title).toBe("fix auth tests");
		expect(f.state.sessionTitle).toBe("My Session");
	}
});

test("quitting clears its own marker without resetting a live busy peer's title", async () => {
	const f = fixture();
	f.input("Task");
	await settle();
	f.state.activePanes.set("%2", "1");
	await f.emit("agent_settled");
	expect(f.state.title).toBe("* fix auth tests");
	await f.emit("session_shutdown");
	expect(f.state.title).toBe("fix auth tests");
	expect(f.state.activePanes.get("%1")).toBe("0");
	expect(f.state.waitingPanes.get("%1")).toBe("0");
	expect(f.state.sessionTitle).toBe("My Session");
	f.state.activePanes.set("%2", "0");
	await f.emit("session_shutdown");
	expect(f.state.title).toBe("zsh");
});

test("active peers in a different window do not prevent quit cleanup", async () => {
	const f = fixture();
	f.input("Task");
	await settle();
	f.state.activePanes.set("%2", "1");
	f.state.otherWindowPanes.add("%2");
	await f.emit("session_shutdown");
	expect(f.state.title).toBe("zsh");
	expect(f.state.activePanes.get("%2")).toBe("1");
});

test("reload and session replacement preserve ownership until Pi quits", async () => {
	for (const reason of ["reload", "new", "resume", "fork"]) {
		const f = fixture([]);
		await f.emit("session_start");
		expect(f.state.activePanes.get("%1")).toBe("1");
		await f.emit("session_shutdown", reason);
		expect(f.state.activePanes.get("%1")).toBe("1");
		f.load();
		await f.emit("session_start", reason);
		expect(f.state.activePanes.get("%1")).toBe("1");
		await f.emit("session_shutdown", "quit");
		expect(f.state.activePanes.get("%1")).toBe("0");
	}
});

test("pinning zsh is a task-title update, not quit cleanup", async () => {
	const f = fixture([]);
	f.state.activePanes.set("%2", "1");
	await f.refresh("set zsh");
	expect(f.state.title).toBe("zsh");
	expect(f.state.activePanes.get("%1")).toBe("1");
	expect(f.calls.at(-1)).toEqual(["rename-window", "-t", "%1", "--", buildWindowTitleFormat("zsh")]);
});

test("shutdown resets a busy title and repeated cleanup makes no extra writes", async () => {
	const f = fixture();
	f.input("Task");
	await settle();
	await f.emit("session_shutdown");
	expect(f.state.title).toBe("zsh");
	expect(f.calls.at(-1)).toEqual(quitCommand());
	const writes = f.calls.filter((args) => args[0] === "rename-window").length;
	await f.emit("session_shutdown");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toHaveLength(writes);
});

test("shutdown resolves the owning window after a pane move", async () => {
	const f = fixture();
	f.input("Task");
	await settle();
	f.state.window = "@3";
	await f.emit("session_shutdown");
	expect(f.calls.at(-1)).toEqual(quitCommand());
});

test("shutdown waits for an in-flight marker write before resetting to zsh", async () => {
	const gate = deferred();
	const f = fixture(undefined, async (args, _signal, title) => {
		if (args[0] === "rename-window" && title?.startsWith(READY_PREFIX)) await gate.promise;
	});
	f.input("Task");
	await settle();
	const completed = f.emit("agent_settled");
	await settle();
	const shutdown = f.emit("session_shutdown");
	gate.resolve(response(""));
	await completed;
	await shutdown;
	expect(f.state.title).toBe("zsh");
	expect(f.calls.at(-1)).toEqual(quitCommand());
});

test("session startup preserves an unmarked custom window name", async () => {
	const f = fixture();
	f.state.title = "Custom Manual Name";
	await f.emit("session_start");
	expect(f.state.title).toBe("Custom Manual Name");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
});

test("status updates stay disabled outside interactive tmux", async () => {
	const f = fixture();
	for (const mode of ["text", "rpc", "json"]) {
		(f.ctx as any).mode = mode;
		f.emit("agent_start");
		await f.emit("agent_settled");
		await f.emit("session_shutdown");
	}
	(f.ctx as any).mode = "tui";
	for (const pane of [undefined, "bad-target"]) {
		if (pane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = pane;
		await f.emit("agent_settled");
		await f.emit("session_shutdown");
	}
	await settle();
	expect(f.calls).toEqual([]);
});

test("status updates resolve the window again after a pane move", async () => {
	const f = fixture();
	f.input("Task");
	await settle();
	f.state.window = "@3";
	await f.emit("agent_settled");
	expect(f.calls.at(-1)).toEqual(renameCommand("fix auth tests"));
});

test("a slow marker write cannot overwrite newer input or its summary", async () => {
	const gate = deferred();
	const f = fixture(
		[Promise.resolve(response("Fix auth tests")), Promise.resolve(response("New task"))],
		async (args, _signal, title) => { if (args[0] === "rename-window" && title?.startsWith(READY_PREFIX)) await gate.promise; },
	);
	f.input("First task");
	await settle();
	const completed = f.emit("agent_settled");
	await settle();
	f.input("Next task");
	await settle();
	gate.resolve(response(""));
	await completed;
	await settle();
	expect(f.state.title).toBe("new task");
	expect(f.state.sessionTitle).toBe("My Session");
	expect(f.calls.at(-1)).toEqual(renameCommand("new task"));
});

test.each([1, 2])("new input invalidates a ready update waiting on slow window lookup %i", async (lookupToHold) => {
	const gate = deferred();
	const next = deferred();
	let holdLookup = false;
	let lookups = 0;
	const f = fixture(
		[Promise.resolve(response("Fix auth tests")), next.promise],
		async (args) => {
			if (holdLookup && args[0] === "display-message" && ++lookups === lookupToHold) await gate.promise;
		},
	);
	f.input("First task");
	await settle();
	holdLookup = true;
	const completed = f.emit("agent_settled");
	await settle();
	f.input("Next task");
	holdLookup = false;
	gate.resolve(response(""));
	await completed;
	await settle();
	expect(f.state.title).toBe("fix auth tests");
	expect(f.writes.filter((title) => title.startsWith(READY_PREFIX))).toEqual([]);
	next.resolve(response("New task"));
	await settle();
});

test("session markers preserve manual names without lowercasing or clipping", async () => {
	const f = fixture();
	const name = "My Café Session " + "X".repeat(40);
	f.state.sessionTitle = name;
	await f.emit("session_start");
	expect(f.state.sessionTitle).toBe(name);
	await f.emit("agent_settled");
	await f.emit("agent_settled");
	expect(f.state.sessionTitle).toBe(READY_PREFIX + name);
	f.emit("agent_start");
	await settle();
	expect(f.state.sessionTitle).toBe(name);
});

test("a busy or exiting pane cannot clear another pane's window or session marker", async () => {
	const f = fixture();
	f.state.waitingPanes.set("%2", "1");
	await f.emit("session_start");
	expect(f.state.title).toBe("* existing task");
	expect(f.state.sessionTitle).toBe("* My Session");
	await f.emit("agent_settled");
	f.emit("agent_start");
	await settle();
	expect(f.state.title).toBe("* existing task");
	expect(f.state.sessionTitle).toBe("* My Session");
	await f.emit("session_shutdown");
	expect(f.state.title).toBe("* existing task");
	expect(f.state.sessionTitle).toBe("* My Session");
	f.state.waitingPanes.set("%2", "0");
	f.emit("agent_start");
	await settle();
	expect(f.state.title).toBe("zsh");
	expect(f.state.sessionTitle).toBe("My Session");
});

test("status updates target the owning session after a pane move", async () => {
	const f = fixture();
	await f.emit("session_start");
	f.state.session = "$3";
	f.state.window = "@4";
	f.state.sessionTitle = "Destination Session";
	await f.emit("agent_settled");
	expect(f.state.sessionTitle).toBe("* Destination Session");
	expect(f.calls.filter((args) => args[0] === "set-option").at(-1)?.[16]).toBe("%1");
});

test("naming context includes text dialogue and summaries, but not tools, thinking, images, or custom messages", () => {
	const context = buildNamingContext([
		{ role: "compactionSummary", summary: "Fix registry routing" },
		{ role: "user", content: [{ type: "text", text: "Inspect the proxy" }, { type: "image", data: "IMAGE_DATA" }] },
		{ role: "assistant", content: [
			{ type: "thinking", thinking: "PRIVATE_THINKING" },
			{ type: "toolCall", name: "bash", arguments: { command: "PRIVATE_ARGUMENT" } },
			{ type: "text", text: "The routing needs a fix" },
		] },
		{ role: "toolResult", content: [{ type: "text", text: "PRIVATE_TOOL_OUTPUT" }] },
		{ role: "custom", content: "PRIVATE_CUSTOM_TEXT" },
		{ role: "bashExecution", output: "PRIVATE_BASH_OUTPUT" },
		{ role: "system", content: [{ type: "text", text: "PRIVATE_SYSTEM_PROMPT" }] },
		{ role: "branchSummary", summary: "Proxy check complete" },
	] as any, "continue");
	expect(context).toBe([
		"summary: Fix registry routing", "user: Inspect the proxy",
		"assistant: The routing needs a fix", "branch summary: Proxy check complete", "user: continue",
	].join("\n\n"));
});

test("naming context bounds history and prioritizes recent dialogue and the new prompt", () => {
	const messages = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `task-${i}` }));
	const context = buildNamingContext(messages as any, "continue");
	expect(context.match(/task-\d+/g)).toHaveLength(MAX_HISTORY_MESSAGES);
	expect(context).not.toContain("task-21");
	expect(context).toContain("task-29");
	expect(context.endsWith("user: continue")).toBe(true);

	const large = buildNamingContext([
		{ role: "compactionSummary", summary: "SUMMARY".repeat(2_000) },
		...Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `${i}:` + "x".repeat(10_000) })),
	] as any, "NEW_PROMPT".repeat(1_000));
	expect(large.length).toBeLessThanOrEqual(MAX_CONTEXT_LENGTH);
	expect(large).toStartWith("summary: SUMMARY");
	expect(large).toContain("user: 29:");
	expect(large.endsWith("user: " + "NEW_PROMPT".repeat(1_000).slice(0, MAX_PROMPT_LENGTH))).toBe(true);
});

test("empty projected context cancels stale naming without preventing a later request", async () => {
	for (const event of ["session_compact", "agent_settled"]) {
		for (const staleResult of [response("Removed task"), response("Synthetic error", "error")]) {
			const old = deferred();
			const f = fixture([old.promise, Promise.resolve(response("Fresh task"))]);
			f.messages.push({ role: "user", content: "Original task" });
			await f.emit("session_start");
			// Context edits can omit all dialogue while retaining non-text entries.
			f.messages.splice(0, f.messages.length, { role: "toolResult", content: [{ type: "text", text: "Excluded output" }] });
			await f.emit(event);
			expect(f.requests[0].options.signal.aborted).toBe(true);
			expect(f.requests).toHaveLength(1);
			old.resolve(staleResult);
			await settle();
			expect(f.state.title).toBe(event === "agent_settled" ? "* existing task" : "existing task");
			expect(f.warnings).toEqual([]);
			expect(f.calls.some((args) => args[0] === "rename-window" && args[4].includes("removed"))).toBe(false);

			// Returning to the original context must not be deduplicated away.
			f.messages.push({ role: "user", content: "Original task" });
			await f.emit("session_compact");
			await settle();
			expect(f.requests).toHaveLength(2);
			expect(f.state.title).toBe(event === "agent_settled" ? "* fresh task" : "fresh task");
		}
	}
});

test.each([1, 2])("compaction invalidates a completed naming result at slow title lookup %i", async (lookupToHold) => {
	for (const empty of [false, true]) {
		for (const failLookup of [false, true]) {
			const old = deferred();
			const next = deferred();
			const gate = deferred();
			let holdLookup = false;
			let lookups = 0;
			const f = fixture([old.promise, next.promise], async (args) => {
				if (holdLookup && args[0] === "display-message" && ++lookups === lookupToHold) {
					await gate.promise;
					if (failLookup) throw new Error("Synthetic stale lookup failure");
				}
			});
			f.messages.push({ role: "user", content: "Original task" });
			await f.emit("session_start");
			holdLookup = true;
			old.resolve(response("Removed task"));
			await settle();
			expect(lookups).toBe(lookupToHold);
			// The model has completed, but its tmux update is still in flight.
			f.messages.splice(0, f.messages.length, ...(empty ? [] : [{ role: "user", content: "Fresh task" }]));
			await f.emit("session_compact");
			holdLookup = false;
			gate.resolve(response(""));
			await settle();
			expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
			expect(f.state.title).toBe("existing task");
			expect(f.warnings).toEqual([]);

			if (empty) {
				f.messages.push({ role: "user", content: "Fresh task" });
				await f.emit("session_compact");
			}
			next.resolve(response("Fresh task"));
			await settle();
			expect(f.state.title).toBe("fresh task");
			expect(f.warnings).toEqual([]);
			// Status-only updates must still work after stale naming is discarded.
			await f.emit("agent_settled");
			expect(f.state.title).toBe("* fresh task");
		}
	}
});

test.each([1, 2])("status updates do not resurrect a superseded candidate at slow lookup %i", async (lookupToHold) => {
	for (const committed of [false, true]) {
		for (const empty of [false, true]) {
			const old = deferred();
			const next = deferred();
			const gate = deferred();
			let holdLookup = false;
			let lookups = 0;
			const f = fixture([
				...(committed ? [Promise.resolve(response("Previous task"))] : []), old.promise, next.promise,
			], async (args) => {
				if (holdLookup && args[0] === "display-message" && ++lookups === lookupToHold) await gate.promise;
			});
			if (committed) {
				f.input("Previous task");
				await settle();
			}
			const previousTitle = committed ? "previous task" : "existing task";
			f.messages.push({ role: "user", content: "Original task" });
			await f.emit("session_compact");
			holdLookup = true;
			old.resolve(response("Removed task"));
			await settle();
			expect(lookups).toBe(lookupToHold);
			f.messages.splice(0, f.messages.length, ...(empty ? [] : [{ role: "user", content: "Fresh task" }]));
			await f.emit("session_compact");
			holdLookup = false;
			gate.resolve(response(""));
			await settle();
			expect(f.state.title).toBe(previousTitle);

			// A status-only refresh must retain the applied title, not the discarded candidate.
			f.emit("agent_start");
			await settle();
			expect(f.state.title).toBe(previousTitle);
			await f.emit("agent_settled");
			expect(f.state.title).toBe("* " + previousTitle);
			expect(f.calls.some((args) => args[0] === "rename-window" && args[4].includes("removed"))).toBe(false);
			if (empty) {
				f.messages.push({ role: "user", content: "Fresh task" });
				await f.emit("session_compact");
			}
			next.resolve(response("Fresh task"));
			await settle();
			expect(f.state.title).toBe("* fresh task");
			expect(f.warnings).toEqual([]);
		}
	}
});

test.each([1, 2])("a status revision still adopts a current candidate at slow lookup %i", async (lookupToHold) => {
	const work = deferred();
	const gate = deferred();
	let holdLookup = false;
	let lookups = 0;
	const f = fixture([work.promise], async (args) => {
		if (holdLookup && args[0] === "display-message" && ++lookups === lookupToHold) await gate.promise;
	});
	f.messages.push({ role: "user", content: "Current task" });
	await f.emit("session_start");
	holdLookup = true;
	work.resolve(response("Current task"));
	await settle();
	expect(lookups).toBe(lookupToHold);
	f.emit("agent_start");
	holdLookup = false;
	gate.resolve(response(""));
	await settle();
	expect(f.state.title).toBe("current task");
	await f.emit("agent_settled");
	expect(f.state.title).toBe("* current task");
	expect(f.requests).toHaveLength(1);
	expect(f.warnings).toEqual([]);
});

test("empty or non-text history does not start a naming request", async () => {
	expect(buildNamingContext([])).toBe("");
	expect(buildNamingContext([{ role: "compactionSummary", summary: " " }] as any)).toBe("");
	const f = fixture();
	f.messages.push({ role: "assistant", content: [{ type: "toolCall", name: "bash" }] });
	await f.emit("session_start");
	await f.emit("agent_settled");
	expect(f.requests).toHaveLength(0);
});

test("brief follow-ups include the active conversation instead of only the new prompt", async () => {
	const f = fixture();
	f.messages.push(
		{ role: "user", content: "Fix authentication tests" },
		{ role: "assistant", content: [{ type: "text", text: "Should I update the fixtures?" }] },
	);
	f.input("yes, do it");
	await settle();
	expect(f.requests[0].context.messages[0].content).toBe([
		"user: Fix authentication tests", "assistant: Should I update the fixtures?", "user: yes, do it",
	].join("\n\n"));
	expect(f.requests[0].context.systemPrompt).toContain("Prefer the latest task when the topic changes");
});

test("startup, resume, fork, and reload name from the active session projection without new input", async () => {
	for (const reason of ["startup", "resume", "fork", "reload"]) {
		const f = fixture();
		f.messages.push({ role: "user", content: "Fix authentication tests" });
		(f.ctx.sessionManager as any).getEntries = () => { throw new Error("Raw session history must not be read"); };
		await f.emit("session_start", reason);
		await settle();
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0].context.messages[0].content).toBe("user: Fix authentication tests");
		expect(f.state.title).toBe("fix auth tests");
	}
});

test("tree navigation cancels an old summary and names only the newly active branch", async () => {
	const old = deferred();
	const f = fixture([old.promise, Promise.resolve(response("registry routing"))]);
	f.messages.push({ role: "user", content: "Fix authentication tests" });
	await f.emit("session_start");
	f.messages.splice(0, f.messages.length, { role: "user", content: "Fix registry routing" });
	await f.emit("session_tree");
	await settle();
	expect(f.requests[0].options.signal.aborted).toBe(true);
	expect(f.requests[1].context.messages[0].content).toBe("user: Fix registry routing");
	old.resolve(response("fix auth tests"));
	await settle();
	expect(f.state.title).toBe("registry routing");
});

test("compaction refreshes from the projected summary without resurrecting original messages", async () => {
	const f = fixture();
	f.messages.push(
		{ role: "compactionSummary", summary: "Fix authentication tests; fixtures need updating" },
		{ role: "user", content: "continue" },
	);
	await f.emit("session_compact");
	await settle();
	expect(f.requests[0].context.messages[0].content).toBe(
		"summary: Fix authentication tests; fixtures need updating\n\nuser: continue",
	);
	expect(f.state.title).toBe("fix auth tests");
});

test("settlement refreshes the task from new assistant context while retaining the waiting marker", async () => {
	const f = fixture([
		Promise.resolve(response("auth tests")), Promise.resolve(response("auth fixtures")),
	]);
	f.input("Fix authentication tests");
	await settle();
	f.messages.push(
		{ role: "user", content: "Fix authentication tests" },
		{ role: "assistant", content: [{ type: "text", text: "Updated the stale authentication fixtures" }] },
	);
	await f.emit("agent_settled");
	await settle();
	expect(f.requests).toHaveLength(2);
	expect(f.requests[1].context.messages[0].content).toContain("assistant: Updated the stale authentication fixtures");
	expect(f.state.title).toBe("* auth fixtures");
	expect(f.state.sessionTitle).toBe("* My Session");
	await f.emit("agent_settled");
	expect(f.requests).toHaveLength(2);
});

test("persisting the same input and adding only tool work does not repeat a naming request", async () => {
	const work = deferred();
	const f = fixture([work.promise]);
	f.input("Fix authentication tests");
	f.messages.push(
		{ role: "user", content: "Fix authentication tests" },
		{ role: "toolResult", content: [{ type: "text", text: "Tool output" }] },
	);
	await f.emit("agent_settled");
	expect(f.requests).toHaveLength(1);
	expect(f.requests[0].options.signal.aborted).toBe(false);
	work.resolve(response("auth tests"));
	await settle();
	expect(f.state.title).toBe("* auth tests");
});

test("parses naming models and rejects malformed configuration", () => {
	for (const value of [undefined, "", "  "]) {
		expect(parseNamingModel(value)).toEqual({ provider: "openai-codex", id: "gpt-6-luna" });
	}
	expect(parseNamingModel(" anthropic/claude-sonnet-4-5 ")).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
	expect(parseNamingModel("openrouter/vendor/model")).toEqual({ provider: "openrouter", id: "vendor/model" });
	expect(parseNamingModel(" OFF ")).toBeNull();
	for (const value of ["model", "/model", "provider/", "bad provider/model", "provider/a\nb", "provider/" + "x".repeat(300)]) {
		expect(() => parseNamingModel(value)).toThrow();
	}
});

test("uses the configured naming model without changing the main model", async () => {
	process.env.PI_TMUX_MODEL = "openrouter/vendor/model";
	const f = fixture();
	f.input("Task");
	await settle();
	expect(f.requests[0].model).toEqual({ provider: "openrouter", id: "vendor/model" });
	expect(f.state.title).toBe("fix auth tests");
});

test("model configuration changes take effect only on extension reload", async () => {
	process.env.PI_TMUX_MODEL = "custom/first";
	const f = fixture();
	process.env.PI_TMUX_MODEL = "off";
	f.input("Task");
	await settle();
	expect(f.requests[0].model).toEqual({ provider: "custom", id: "first" });
	await f.emit("session_shutdown", "reload");
	f.load();
	f.messages.push({ role: "user", content: "Task" });
	await f.emit("session_start", "reload");
	await f.emit("agent_settled");
	expect(f.requests).toHaveLength(1);
	expect(f.state.title).toBe("* fix auth tests");
});

test("unavailable configured models do not fall back to the default", async () => {
	process.env.PI_TMUX_MODEL = "custom/missing";
	const f = fixture();
	const lookups: string[][] = [];
	(f.ctx.modelRegistry as any).find = (provider: string, id: string) => {
		lookups.push([provider, id]);
		return undefined;
	};
	f.input("Task");
	await settle();
	expect(lookups).toEqual([["custom", "missing"]]);
	expect(f.requests).toHaveLength(0);
	expect(f.warnings).toHaveLength(1);
});

test("status-only mode makes no model or projection calls and keeps lifecycle markers", async () => {
	process.env.PI_TMUX_MODEL = "off";
	const f = fixture();
	(f.ctx.sessionManager as any).buildSessionProjection = () => { throw new Error("Must not collect naming context"); };
	await f.emit("session_start");
	f.input("Task");
	await f.emit("session_compact");
	await f.emit("agent_settled");
	expect(f.state.title).toBe("* existing task");
	expect(f.state.sessionTitle).toBe("* My Session");
	await f.refresh();
	f.emit("agent_start");
	await settle();
	expect(f.state.title).toBe("existing task");
	await f.emit("session_shutdown");
	expect(f.state.title).toBe("zsh");
	expect(f.requests).toHaveLength(0);
	expect(f.warnings).toHaveLength(0);
	expect(f.notices.join(" ")).toContain("disabled");
});

test("invalid configuration disables naming, warns once, and never echoes its value", async () => {
	process.env.PI_TMUX_MODEL = "invalid synthetic value";
	const f = fixture();
	await f.emit("session_start");
	f.input("Task");
	await f.emit("agent_settled");
	expect(f.requests).toHaveLength(0);
	expect(f.warnings).toHaveLength(1);
	expect(f.warnings[0]).toContain("PI_TMUX_MODEL");
	expect(f.warnings[0]).not.toContain(process.env.PI_TMUX_MODEL);
	expect(f.state.title).toBe("* existing task");
});

test("manual refresh retries identical failed context and retains waiting status", async () => {
	const f = fixture([Promise.resolve(response("", "error")), Promise.resolve(response("recovered task"))]);
	f.messages.push({ role: "user", content: "Task" });
	await f.emit("session_start");
	await settle();
	await f.emit("agent_settled");
	expect(f.requests).toHaveLength(1);
	expect(f.warnings).toHaveLength(1);
	await f.refresh();
	await settle();
	expect(f.requests).toHaveLength(2);
	expect(f.state.title).toBe("* recovered task");
	expect(f.state.sessionTitle).toBe("* My Session");
	await f.emit("agent_settled");
	expect(f.requests).toHaveLength(2);
});

test("manual refresh cancels pending naming and does not wait for the replacement result", async () => {
	const old = deferred();
	const next = deferred();
	const f = fixture([old.promise, next.promise]);
	f.messages.push({ role: "user", content: "Task" });
	await f.emit("session_start");
	await f.refresh();
	expect(f.requests).toHaveLength(2);
	expect(f.requests[0].options.signal.aborted).toBe(true);
	old.resolve(response("old task"));
	next.resolve(response("new task"));
	await settle();
	expect(f.state.title).toBe("new task");
});

test.each([1, 2])("manual retry discards a completed candidate at slow lookup %i", async (lookup) => {
	const old = deferred();
	const next = deferred();
	const gate = deferred();
	let hold = false;
	let lookups = 0;
	const f = fixture([old.promise, next.promise], async (args) => {
		if (hold && args[0] === "display-message" && ++lookups === lookup) await gate.promise;
	});
	f.messages.push({ role: "user", content: "Task" });
	await f.emit("session_start");
	hold = true;
	old.resolve(response("discarded task"));
	await settle();
	await f.refresh();
	const settled = f.emit("agent_settled");
	hold = false;
	gate.resolve(response(""));
	await settled;
	expect(f.requests).toHaveLength(2);
	expect(f.state.title).toBe("* existing task");
	next.resolve(response("retry task"));
	await settle();
	expect(f.state.title).toBe("* retry task");
	expect(f.calls.filter((args) => args[0] === "rename-window").some((args) => args.at(-1)?.includes("discarded"))).toBe(false);
});

test("manual refresh rejects arguments, empty context, and noninteractive targets", async () => {
	const f = fixture();
	await f.refresh("unexpected args");
	await f.refresh();
	f.messages.push({ role: "user", content: "Task" });
	for (const mode of ["rpc", "json", "text"]) {
		(f.ctx as any).mode = mode;
		await f.refresh();
	}
	(f.ctx as any).mode = "tui";
	delete process.env.TMUX_PANE;
	await f.refresh();
	await settle();
	expect(f.requests).toHaveLength(0);
	expect(f.calls).toHaveLength(0);
});

test("manual refresh with empty context cancels work for removed dialogue", async () => {
	const work = deferred();
	const f = fixture([work.promise]);
	f.messages.push({ role: "user", content: "Task" });
	await f.emit("session_start");
	f.messages.length = 0;
	await f.refresh();
	expect(f.requests[0].options.signal.aborted).toBe(true);
	work.resolve(response("removed task"));
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.requests).toHaveLength(1);
	expect(f.notices.join(" ")).toContain("No text");
});

test("manual refresh permits a new warning after a previous naming failure", async () => {
	const f = fixture();
	(f.ctx.modelRegistry as any).find = () => undefined;
	f.messages.push({ role: "user", content: "Task" });
	await f.emit("session_start");
	await settle();
	await f.refresh();
	await settle();
	expect(f.warnings).toHaveLength(2);
});

test("manual titles remain pinned through input, settlement, compaction, and refresh", async () => {
	const f = fixture([]);
	await f.refresh('set "Fix café # auth"');
	(f.ctx.sessionManager as any).buildSessionProjection = () => { throw new Error("Pinned titles must not collect naming context"); };
	expect(f.state.title).toBe("fix cafe auth");
	f.input("Another task");
	await f.emit("agent_settled");
	await f.emit("session_compact");
	await f.refresh();
	expect(f.state.title).toBe("* fix cafe auth");
	expect(f.requests).toHaveLength(0);
	expect(f.warnings).toHaveLength(0);
	f.emit("agent_start");
	await settle();
	expect(f.state.title).toBe("fix cafe auth");
});

test("pinning a title cancels pending AI work without losing waiting status", async () => {
	const work = deferred();
	const f = fixture([work.promise]);
	f.input("Task");
	await f.emit("agent_settled");
	await f.refresh("set -manual title");
	expect(f.requests[0].options.signal.aborted).toBe(true);
	work.resolve(response("late ai title"));
	await settle();
	expect(f.state.title).toBe("* -manual title");
	expect(f.state.sessionTitle).toBe("* My Session");
});

test.each([1, 2])("pinning a title discards completed AI output at slow lookup %i", async (lookup) => {
	const work = deferred();
	const gate = deferred();
	let hold = false;
	let lookups = 0;
	const f = fixture([work.promise], async (args) => {
		if (hold && args[0] === "display-message" && ++lookups === lookup) await gate.promise;
	});
	f.input("Task");
	await settle();
	hold = true;
	work.resolve(response("discarded ai title"));
	await settle();
	const pinned = f.refresh("set manual title");
	hold = false;
	gate.resolve(response(""));
	await pinned;
	await f.emit("agent_settled");
	expect(f.state.title).toBe("* manual title");
	expect(f.calls.filter((args) => args[0] === "rename-window").some((args) => args.at(-1)?.includes("discarded"))).toBe(false);
});

test("auto resumes naming from identical context and preserves waiting status", async () => {
	const f = fixture([Promise.resolve(response("ai title")), Promise.resolve(response("resumed title"))]);
	f.messages.push({ role: "user", content: "Task" });
	await f.emit("session_start");
	await settle();
	await f.emit("agent_settled");
	await f.refresh("set manual title");
	await f.refresh("auto");
	await settle();
	expect(f.requests).toHaveLength(2);
	expect(f.state.title).toBe("* resumed title");
	await f.emit("agent_settled");
	expect(f.requests).toHaveLength(2);
});

test("manual titles work with AI disabled, and auto respects that setting", async () => {
	process.env.PI_TMUX_MODEL = "off";
	const f = fixture([]);
	await f.refresh("set " + "X".repeat(30));
	expect(f.state.title).toBe("x".repeat(24));
	await f.emit("agent_settled");
	expect(f.state.title).toBe("* " + "x".repeat(22));
	await f.refresh("auto");
	expect(f.state.title).toBe("* " + "x".repeat(22));
	expect(f.requests).toHaveLength(0);
	await f.emit("session_shutdown");
	expect(f.state.title).toBe("zsh");
});

test("invalid manual titles do not cancel pending naming or change the window", async () => {
	const work = deferred();
	const f = fixture([work.promise]);
	f.input("Task");
	await settle();
	for (const args of ["set", "set ---", "set #[]", "unknown command"]) await f.refresh(args);
	expect(f.requests[0].options.signal.aborted).toBe(false);
	expect(f.state.title).toBe("existing task");
	expect(f.warnings).toHaveLength(4);
	work.resolve(response("ai title"));
	await settle();
	expect(f.state.title).toBe("ai title");
});

test("session replacement, tree navigation, and reload release manual pins", async () => {
	for (const event of ["session_start", "session_tree"]) {
		const f = fixture();
		await f.refresh("set manual title");
		f.messages.push({ role: "user", content: "Task" });
		await f.emit(event);
		await settle();
		expect(f.state.title).toBe("fix auth tests");
		expect(f.requests).toHaveLength(1);
	}
	const f = fixture();
	await f.refresh("set manual title");
	await f.emit("session_shutdown", "reload");
	f.load();
	f.messages.push({ role: "user", content: "Task" });
	await f.emit("session_start", "reload");
	await settle();
	expect(f.state.title).toBe("fix auth tests");
});

test("manual title retries can report a new tmux failure", async () => {
	const f = fixture([], async () => { throw new Error("Synthetic tmux failure"); });
	await f.refresh("set first manual title");
	await f.refresh("set second manual title");
	expect(f.warnings).toHaveLength(2);
	expect(f.requests).toHaveLength(0);
});

test("manual title commands cannot write to tmux outside interactive mode", async () => {
	const f = fixture();
	for (const mode of ["rpc", "json", "text"]) {
		(f.ctx as any).mode = mode;
		await f.refresh("set manual title");
		await f.refresh("auto");
	}
	(f.ctx as any).mode = "tui";
	delete process.env.TMUX_PANE;
	await f.refresh("set manual title");
	expect(f.calls).toHaveLength(0);
	expect(f.requests).toHaveLength(0);
});

test("tmux failures are contained and warn only once", async () => {
	const f = fixture([], async () => { throw new Error("Synthetic tmux failure"); });
	await f.emit("agent_settled");
	f.emit("agent_start");
	await settle();
	await f.emit("agent_settled");
	expect(f.state.title).toBe("existing task");
	expect(f.warnings).toHaveLength(1);
	expect(f.requests).toHaveLength(0);
});
