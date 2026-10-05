import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piTmux, { buildNamingContext, cleanTitle, formatTitle, MAX_CONTEXT_LENGTH, MAX_HISTORY_MESSAGES, MAX_PROMPT_LENGTH, MAX_TITLE_LENGTH, READY_PREFIX, SESSION_TITLE_FORMAT, WAITING_OPTION, type RunTmux } from "../index";

let originalPane: string | undefined;
beforeEach(() => {
	originalPane = process.env.TMUX_PANE;
	process.env.TMUX_PANE = "%1";
});
afterEach(() => {
	if (originalPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = originalPane;
});

const response = (text: string, stopReason = "stop") => ({
	content: [{ type: "text", text }],
	stopReason,
});

function fixture(
	results: Promise<ReturnType<typeof response>>[] = [Promise.resolve(response("Fix auth tests"))],
	beforeCommand?: (args: string[], signal: AbortSignal) => Promise<void>,
) {
	const handlers = new Map<string, Function>();
	const calls: string[][] = [];
	const requests: { model: unknown; context: any; options: any }[] = [];
	const warnings: string[] = [];
	const messages: any[] = [];
	const ctx = {
		mode: "tui",
		sessionManager: { buildSessionProjection: () => ({ messages }) },
		ui: { notify: (text: string) => warnings.push(text) },
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
	};
	const tmux: RunTmux = async (args, signal) => {
		calls.push(args);
		if (beforeCommand) await beforeCommand(args, signal);
		if (args[0] === "display-message") return `${state.session}\t${state.window}\t${state.title}`;
		if (args[0] === "set-option") {
			expect(args).toEqual([
				"set-option", "-p", "-t", "%1", WAITING_OPTION, args[5],
				";", "rename-session", "-t", state.session, SESSION_TITLE_FORMAT,
			]);
			state.waitingPanes.set(args[3], args[5]);
			const anyWaiting = [...state.waitingPanes.values()].includes("1");
			state.sessionTitle = (anyWaiting ? READY_PREFIX : "") + state.sessionTitle.replace(/^\* /, "");
		}
		if (args[0] === "rename-window") state.title = args[3];
		return "";
	};
	const load = () => piTmux({ on: (event: string, handler: Function) => handlers.set(event, handler) } as unknown as ExtensionAPI, tmux);
	load();
	const input = (text: string, source = "interactive") => handlers.get("input")!({ text, source }, ctx);
	const emit = (event: string, reason = event === "session_shutdown" ? "quit" : "startup") =>
		handlers.get(event)?.({ type: event, reason }, ctx);
	return { handlers, calls, requests, warnings, messages, ctx, input, emit, state, load };
}

async function settle() {
	for (let i = 0; i < 40; i++) await Promise.resolve();
}

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
		["rename-window", "-t", "@2", "fix auth tests"],
	]);
	expect(f.calls[0]).toEqual(["display-message", "-p", "-t", "%1", "#{session_id}\t#{window_id}\t#{window_name}"]);
	expect(f.warnings).toEqual([]);
});

test("bounds prompt and output and disables reasoning and retries", async () => {
	const f = fixture();
	f.input("x".repeat(10_000));
	await settle();
	const request = f.requests[0];
	expect(request.context.messages).toHaveLength(1);
	expect(request.context.messages[0].content).toBe("user: " + "x".repeat(MAX_PROMPT_LENGTH));
	expect(request.options).toMatchObject({ maxTokens: 96, reasoning: "off", maxRetries: 0, cacheRetention: "none" });
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
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([["rename-window", "-t", "@2", "new task"]]);
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
			event === "session_shutdown" ? [["rename-window", "-t", "@2", "zsh"]] : [],
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
	await f.emit("agent_settled");
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
		expect(f.calls.filter((args) => args[0] === "rename-window" && args[3] === "zsh")).toEqual([]);
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

test("shutdown resets a busy title and repeated cleanup makes no extra writes", async () => {
	const f = fixture();
	f.input("Task");
	await settle();
	await f.emit("session_shutdown");
	expect(f.state.title).toBe("zsh");
	expect(f.calls.at(-1)).toEqual(["rename-window", "-t", "@2", "zsh"]);
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
	expect(f.calls.at(-1)).toEqual(["rename-window", "-t", "@3", "zsh"]);
});

test("shutdown waits for an in-flight marker write before resetting to zsh", async () => {
	const gate = deferred();
	const f = fixture(undefined, async (args) => {
		if (args[0] === "rename-window" && args[3].startsWith(READY_PREFIX)) await gate.promise;
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
	expect(f.calls.at(-1)).toEqual(["rename-window", "-t", "@2", "zsh"]);
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
	expect(f.calls.at(-1)).toEqual(["rename-window", "-t", "@3", "* fix auth tests"]);
});

test("a slow marker write cannot overwrite newer input or its summary", async () => {
	const gate = deferred();
	const f = fixture(
		[Promise.resolve(response("Fix auth tests")), Promise.resolve(response("New task"))],
		async (args) => { if (args[0] === "rename-window" && args[3].startsWith(READY_PREFIX)) await gate.promise; },
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
	expect(f.calls.at(-1)).toEqual(["rename-window", "-t", "@2", "new task"]);
});

test("new input invalidates a ready update waiting on a slow window lookup", async () => {
	const gate = deferred();
	const next = deferred();
	let holdLookup = false;
	const f = fixture(
		[Promise.resolve(response("Fix auth tests")), next.promise],
		async (args) => { if (holdLookup && args[0] === "display-message") await gate.promise; },
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
	expect(f.calls.filter((args) => args[0] === "rename-window" && args[3].startsWith(READY_PREFIX))).toEqual([]);
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

test("a busy or exiting pane cannot clear another pane's session marker", async () => {
	const f = fixture();
	f.state.waitingPanes.set("%2", "1");
	await f.emit("session_start");
	expect(f.state.sessionTitle).toBe("* My Session");
	await f.emit("agent_settled");
	f.emit("agent_start");
	await settle();
	expect(f.state.sessionTitle).toBe("* My Session");
	await f.emit("session_shutdown");
	expect(f.state.sessionTitle).toBe("* My Session");
	f.state.waitingPanes.set("%2", "0");
	f.emit("agent_start");
	await settle();
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
	expect(f.calls.filter((args) => args[0] === "set-option").at(-1)?.[9]).toBe("$3");
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
