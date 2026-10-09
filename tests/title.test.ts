import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { getEventListeners } from "node:events";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piTmux, { buildNamingContext, buildWindowTitleFormat, WINDOW_INFO_FORMAT, WINDOW_WAITING_FORMAT, cleanTitle, formatTitle, parseNamingModel, MAX_CONTEXT_LENGTH, MAX_HISTORY_MESSAGES, MAX_PROMPT_LENGTH, MAX_TITLE_LENGTH, READY_PREFIX, SESSION_TITLE_FORMAT, STATUS_INFO_FORMAT, WAITING_OPTION, ACTIVE_OPTION, QUIT_TITLE_FORMAT, type RunTmux } from "../index";

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
	const commands = new Map<string, { handler: Function; getArgumentCompletions?: Function }>();
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
		windowInfo: undefined as string | undefined,
		statusInfo: undefined as string | undefined,
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
		if (args[0] === "display-message" && args[4] === STATUS_INFO_FORMAT) {
			return state.statusInfo ?? `${state.session}\t${state.window}\t${state.waitingPanes.get("%1") === "1" ? "1" : "0"}\t${windowWaiting() ? "1" : "0"}\t${[...state.waitingPanes.values()].includes("1") ? "1" : "0"}`;
		}
		if (args[0] === "display-message") return state.windowInfo ?? `${state.session}\t${state.window}\t${windowWaiting() ? "1" : "0"}\t${state.title}`;
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
		registerCommand: (name: string, command: { handler: Function; getArgumentCompletions?: Function }) => commands.set(name, command),
	} as unknown as ExtensionAPI, tmux);
	load();
	const input = (text: string, source = "interactive") => handlers.get("input")!({ text, source }, ctx);
	const emit = (event: string, reason = event === "session_shutdown" ? "quit" : "startup") =>
		handlers.get(event)?.({ type: event, reason }, ctx);
	return { handlers, calls, writes, requests, warnings, notices, messages, ctx, input, emit, state, load,
		refresh: (args = "") => commands.get("tmux-title")!.handler(args, ctx),
		complete: (prefix = "") => commands.get("tmux-title")!.getArgumentCompletions!(prefix),
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

async function withNamingTimers(run: (timers: { handle: ReturnType<typeof setTimeout>; fire: () => void }[], cleared: Set<unknown>) => Promise<void>) {
	const nativeSet = globalThis.setTimeout;
	const nativeClear = globalThis.clearTimeout;
	const timers: { handle: ReturnType<typeof setTimeout>; fire: () => void }[] = [];
	const cleared = new Set<unknown>();
	const set = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
		const handle = nativeSet(callback, delay, ...args);
		if (delay === 15_000) timers.push({ handle, fire: () => callback(...args) });
		return handle;
	}) as typeof globalThis.setTimeout);
	const clear = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
		cleared.add(handle);
		nativeClear(handle as Timer);
	});
	try { await run(timers, cleared); }
	finally {
		set.mockRestore();
		clear.mockRestore();
		for (const { handle } of timers) nativeClear(handle as Timer);
	}
}

test("cleans markup, accents, controls, and tmux formatting characters", () => {
	expect(cleanTitle('"Fix café\n# auth"\u001b')).toBe("fix cafe auth");
	expect(cleanTitle("Fix auth tests")).toBe("fix auth tests");
	expect(cleanTitle("FIX API Titles")).toBe("fix api titles");
	expect(cleanTitle("#[]\n\u001b")).toBe("");
	expect(cleanTitle("---")).toBe("");
});

test("removes combining marks from Unicode blocks beyond the basic diacritics range", () => {
	expect(cleanTitle("Fix e\u1ab0mail tests")).toBe("fix email tests");
});

test("caps names at 24 ASCII cells, preferably on a word boundary", () => {
	expect(cleanTitle("Investigate authentication failures")).toBe("investigate");
	expect(cleanTitle("x".repeat(80))).toHaveLength(MAX_TITLE_LENGTH);
	expect(cleanTitle("x".repeat(24))).toHaveLength(MAX_TITLE_LENGTH);
});

test("accepts an empty window-name field and supplies the waiting fallback", async () => {
	const f = fixture();
	f.state.title = "";
	await f.emit("session_start");
	expect(f.state.title).toBe("");
	expect(f.writes).toEqual([]);
	expect(f.warnings).toEqual([]);

	await f.emit("agent_settled");
	expect(f.state.title).toBe("* pi");
	expect(f.warnings).toEqual([]);
});

test("an empty server-PID field remains compatible with older tmux adapters", async () => {
	const handlers = new Map<string, Function>();
	const calls: string[][] = [];
	const warnings: string[] = [];
	piTmux({ on: (event: string, handler: Function) => handlers.set(event, handler), registerCommand: () => {} } as unknown as ExtensionAPI,
		async (args) => {
			calls.push(args);
			return args[0] === "display-message" ? "$0:1:\t@2\t0\tcustom name" : "";
		});
	const ctx = { mode: "tui", sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
		ui: { notify: (text: string) => warnings.push(text) } } as unknown as ExtensionContext;
	await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
	expect(calls[0]).toEqual(["display-message", "-p", "-t", "%1", WINDOW_INFO_FORMAT]);
	expect(calls[1][0]).toBe("set-option");
	expect(warnings).toEqual([]);
});

test.each([
	["invalid-session", "@2", "0", "custom"],
	["$0", "invalid-window", "0", "custom"],
	["$0", "@2", "2", "custom"],
	["$0", "@2", "0"],
].map((fields) => fields.join("\t")))("malformed tmux window snapshot %s is rejected without writes", async (info) => {
	const f = fixture();
	f.state.windowInfo = info;
	await f.emit("session_start");
	await f.emit("agent_settled");
	expect(f.calls.filter((args) => args[0] !== "display-message")).toEqual([]);
	expect(f.warnings).toEqual(["tmux window/session status could not be updated. Check tmux."]);
	expect(f.requests).toEqual([]);
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

test("extension instances keep pins and pending naming state isolated", async () => {
	const first = fixture();
	const pending = deferred();
	const second = fixture([pending.promise]);

	await first.refresh("set isolated title");
	expect(first.state.title).toBe("isolated title");
	expect(first.requests).toHaveLength(0);

	second.input("Name a different task");
	await settle();
	expect(second.requests).toHaveLength(1);

	// Resetting one instance must not abort another instance's request
	// or erase its result.
	await first.emit("session_tree");
	expect(second.requests[0].options.signal.aborted).toBe(false);
	pending.resolve(response("second task"));
	await settle();
	expect(second.state.title).toBe("second task");
	expect(first.state.title).toBe("isolated title");
	expect(second.warnings).toEqual([]);
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

test("balances oversized prompt context and disables reasoning and retries", async () => {
	const f = fixture();
	f.input("x".repeat(10_000));
	await settle();
	const request = f.requests[0];
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const suffixLength = Math.floor(retainedLength / 2);
	expect(request.context.messages).toHaveLength(1);
	expect(request.context.messages[0].content).toBe(
		`user: ${"x".repeat(prefixLength)}\n${marker}\n${"x".repeat(suffixLength)}`,
	);
	expect(request.options).toMatchObject({ maxTokens: 96, reasoning: undefined, maxRetries: 0, cacheRetention: "none" });
});

test("retains task intent from both ends of a long prompt", () => {
	const prompt = `TASK: fix authentication tests\n${"x".repeat(10_000)}MIDDLE_SENTINEL${"y".repeat(10_000)}\nAlso add a regression test.`;
	const context = buildNamingContext([], prompt);
	expect(context).toContain("user: TASK: fix authentication tests");
	expect(context).toContain("Also add a regression test.");
	expect(context).toContain("[... middle of prompt omitted ...]");
	expect(context).not.toContain("MIDDLE_SENTINEL");
	expect(context.length).toBeLessThanOrEqual("user: ".length + MAX_PROMPT_LENGTH);
});

test("does not split a supplementary character at the start of a retained prompt suffix", () => {
	const marker = "[... middle of prompt omitted ...]";
	const suffixLength = Math.floor((MAX_PROMPT_LENGTH - marker.length - 2) / 2);
	const prompt = `TASK${"m".repeat(10_000)}😀${"x".repeat(suffixLength - 1)}`;
	const context = buildNamingContext([], prompt);
	const suffix = context.split(`\n${marker}\n`)[1];
	expect(suffix).toBe("x".repeat(suffixLength - 1));
});

test("input skips trimming a bounded prompt's unneeded suffix", async () => {
	const f = fixture();
	const trim = spyOn(String.prototype, "trim").mockImplementation(() => {
		throw new Error("The input gate must not scan the prompt suffix");
	});
	try {
		expect(f.input("Task" + " ".repeat(100_000))).toEqual({ action: "continue" });
	} finally {
		trim.mockRestore();
	}
	await settle();
	expect(f.requests[0].context.messages[0].content).toBe("user: Task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([renameCommand("fix auth tests")]);
});

test("ignores print/RPC, injected messages, empty input, and non-tmux sessions", async () => {
	const f = fixture();
	f.input("", "interactive");
	f.input("\u00a0\ufeff \n\t", "interactive");
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

test("deadline settles pending naming even when the provider never settles", async () => {
	await withNamingTimers(async (timers, cleared) => {
		const f = fixture([new Promise(() => {})]);
		f.input("synthetic task");
		await settle();
		expect(timers).toHaveLength(1);
		expect(timers[0].handle.hasRef()).toBe(false);
		timers[0].fire();
		await settle();
		expect(f.requests[0].options.signal.aborted).toBe(true);
		expect(cleared.has(timers[0].handle)).toBe(true);
		expect(getEventListeners(f.requests[0].options.signal, "abort")).toHaveLength(0);
		await f.refresh("status");
		expect(f.notices.at(-1)).toContain("Naming request: idle");
		expect(f.warnings).toHaveLength(1);
		expect(f.state.title).toBe("existing task");
		await f.emit("agent_settled");
		expect(f.state.title).toBe("* existing task");
		expect(f.requests).toHaveLength(1);
	});
});

test.each(["resolve", "reject"])("late provider %s after timeout is consumed without changing the title or warning again", async (completion) => {
	await withNamingTimers(async (timers) => {
		let resolve!: (value: ReturnType<typeof response>) => void;
		let reject!: (error: Error) => void;
		const work = new Promise<ReturnType<typeof response>>((done, fail) => { resolve = done; reject = fail; });
		const f = fixture([work]);
		f.input("synthetic task");
		await settle();
		timers[0].fire();
		await settle();
		expect(f.warnings).toHaveLength(1);
		if (completion === "resolve") resolve(response("stale late title"));
		else reject(new Error("Synthetic private provider error"));
		await settle();
		expect(f.warnings).toHaveLength(1);
		expect(f.warnings.join("\n")).not.toContain("Synthetic private provider error");
		expect(f.state.title).toBe("existing task");
	});
});

test("a retry after timeout works and late cleanup cannot clear a newer pending request", async () => {
	await withNamingTimers(async (timers, cleared) => {
		const old = deferred();
		const fresh = deferred();
		const f = fixture([old.promise, fresh.promise]);
		f.input("synthetic task");
		await settle();
		f.messages.push({ role: "user", content: "synthetic task" });
		timers[0].fire();
		await settle();
		await f.refresh();
		expect(f.requests).toHaveLength(2);
		expect(cleared.has(timers[0].handle)).toBe(true);
		expect(cleared.has(timers[1].handle)).toBe(false);
		old.resolve(response("stale title"));
		await settle();
		await f.refresh("status");
		expect(f.notices.at(-1)).toContain("Naming request: pending");
		fresh.resolve(response("fresh title"));
		await settle();
		expect(f.state.title).toBe("fresh title");
		expect(cleared.has(timers[1].handle)).toBe(true);
		expect(getEventListeners(f.requests[1].options.signal, "abort")).toHaveLength(0);
	});
});

test.each(["new input", "manual pin", "reload", "quit", "session tree"])("%s releases naming timers and listeners even when the provider hangs", async (cancellation) => {
	await withNamingTimers(async (timers, cleared) => {
		const work = deferred();
		const f = fixture([work.promise, new Promise(() => {})]);
		f.input("synthetic task");
		await settle();
		if (cancellation === "new input") f.input("another task");
		else if (cancellation === "manual pin") await f.refresh("set pinned task");
		else if (cancellation === "session tree") await f.emit("session_tree");
		else await f.emit("session_shutdown", cancellation);
		await settle();
		expect(cleared.has(timers[0].handle)).toBe(true);
		expect(getEventListeners(f.requests[0].options.signal, "abort")).toHaveLength(0);
		expect(f.warnings).toEqual([]);
		work.resolve(response("stale title"));
		await settle();
		expect(f.state.title).not.toBe("stale title");
		expect(f.warnings).toEqual([]);
		await f.emit("session_shutdown", "quit");
	});
});

test.each(["success", "rejection", "promise rejection", "stream throw", "result throw", "unavailable"])("naming %s clears the timer and abort listener", async (completion) => {
	await withNamingTimers(async (timers, cleared) => {
		const work = deferred();
		const f = fixture([work.promise]);
		if (completion === "promise rejection") (f.ctx.modelRegistry as any).streamSimple = () => ({ result: () => Promise.reject(new Error("Synthetic provider rejection")) });
		if (completion === "stream throw") (f.ctx.modelRegistry as any).streamSimple = () => { throw new Error("Synthetic stream failure"); };
		if (completion === "result throw") (f.ctx.modelRegistry as any).streamSimple = () => ({ result: () => { throw new Error("Synthetic result failure"); } });
		if (completion === "unavailable") (f.ctx.modelRegistry as any).find = () => undefined;
		f.input("synthetic task");
		await settle();
		if (completion === "success") work.resolve(response("fresh title"));
		if (completion === "rejection") work.resolve(response("", "error"));
		await settle();
		expect(cleared.has(timers[0].handle)).toBe(true);
		if (f.requests[0]) expect(getEventListeners(f.requests[0].options.signal, "abort")).toHaveLength(0);
		await f.refresh("status");
		expect(f.notices.at(-1)).toContain("Naming request: idle");
		expect(f.warnings).toHaveLength(completion === "success" ? 0 : 1);
	});
});

test("cancellation during model lookup skips credential checks and provider startup", async () => {
	await withNamingTimers(async (timers, cleared) => {
		const f = fixture();
		let authChecks = 0;
		(f.ctx.modelRegistry as any).hasConfiguredAuth = () => { authChecks++; return true; };
		(f.ctx.modelRegistry as any).find = () => {
			void f.emit("session_shutdown", "reload");
			return { provider: "synthetic", id: "synthetic" };
		};
		f.input("synthetic task");
		await settle();
		expect(authChecks).toBe(0);
		expect(f.requests).toEqual([]);
		expect(cleared.has(timers[0].handle)).toBe(true);
		expect(f.warnings).toEqual([]);
	});
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

test("uses only final_answer text blocks when available", async () => {
	const result = {
		...response(""),
		content: [
			{
				type: "text",
				text: "I'll inspect the conversation and choose a title.",
				textSignature: JSON.stringify({ v: 1, id: "commentary-message", phase: "commentary" }),
			},
			{
				type: "text",
				text: "fix ssh helpers",
				textSignature: JSON.stringify({ v: 1, id: "final-message", phase: "final_answer" }),
			},
		],
	};
	const f = fixture([Promise.resolve(result)]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("fix ssh helpers");
	expect(f.warnings).toEqual([]);
});

test("does not use commentary text when no final_answer block is present", async () => {
	const result = {
		...response(""),
		content: [{
			type: "text",
			text: "fix ssh helpers",
			textSignature: JSON.stringify({ v: 1, id: "commentary-message", phase: "commentary" }),
		}],
	};
	const f = fixture([Promise.resolve(result)]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(f.warnings).toEqual(["The naming model did not return a short title; the current title was kept."]);
});

test("does not fall back to an unrecognized text phase", async () => {
	const result = {
		...response(""),
		content: [{
			type: "text",
			text: "repair auth tests",
			textSignature: JSON.stringify({ v: 1, id: "analysis-message", phase: "analysis" }),
		}],
	};
	const f = fixture([Promise.resolve(result)]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(f.warnings).toEqual(["The naming model did not return a short title; the current title was kept."]);
});

test("honors phase metadata from a newer textSignature version", async () => {
	const result = {
		...response(""),
		content: [{
			type: "text",
			text: "repair auth tests",
			textSignature: JSON.stringify({ v: 2, id: "commentary-message", phase: "commentary" }),
		}],
	};
	const f = fixture([Promise.resolve(result)]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(f.warnings).toEqual(["The naming model did not return a short title; the current title was kept."]);
});

test("falls back to the last text block when phase metadata is absent", async () => {
	const result = {
		...response(""),
		content: [
			{ type: "text", text: "Earlier commentary that is not a title" },
			{ type: "text", text: "repair test fixtures" },
		],
	};
	const f = fixture([Promise.resolve(result)]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("repair test fixtures");
	expect(f.warnings).toEqual([]);
});

test("falls back to the last text block with opaque provider signatures", async () => {
	const result = {
		...response(""),
		content: [
			{ type: "text", text: "Earlier provider output", textSignature: "opaque-commentary-id" },
			{ type: "text", text: "repair auth tests", textSignature: "opaque-final-id" },
		],
	};
	const f = fixture([Promise.resolve(result)]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("repair auth tests");
	expect(f.warnings).toEqual([]);
});

test.each([
	"I'll inspect the conversation and choose a title.",
	"one two three four five",
	"fix ssh\nhelpers",
	"investigate authentication failures",
])("rejects non-title model output rather than clipping it: %s", async (output) => {
	const f = fixture([Promise.resolve(response(output))]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(f.warnings).toEqual(["The naming model did not return a short title; the current title was kept."]);
});

test("does not apply a short-looking response truncated by the token limit", async () => {
	const f = fixture([Promise.resolve(response("fix ssh", "length"))]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(f.warnings).toEqual(["The naming model did not return a short title; the current title was kept."]);
});

test("credential-shaped model output is rejected without applying or disclosing it", async () => {
	const outputs = [
		["gh", "p_", "a".repeat(36)].join(""),
		["github", "_pat_", "a".repeat(30)].join(""),
		["AKIA", "A".repeat(16)].join(""),
		["ASIA", "A".repeat(16)].join(""),
		["AIza", "A".repeat(32)].join(""),
		["sk", "-proj-", "a".repeat(32)].join(""),
		["sk", "_live_", "a".repeat(24)].join(""),
		["xoxb-", "a".repeat(24)].join(""),
		["npm_", "a".repeat(24)].join(""),
		["eyJ", "a".repeat(8), ".", "b".repeat(8), ".", "c".repeat(8)].join(""),
		["Bearer ", "a".repeat(24)].join(""),
		["-----BEGIN ", "PRIVATE KEY-----"].join(""),
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(output);
	}

	const split = ["gh", "p_", "a".repeat(36)];
	const splitResponse = {
		...response(""),
		content: split.map((text, index) => ({
			type: "text",
			text,
			textSignature: JSON.stringify({ v: 1, id: `split-${index}`, phase: "final_answer" }),
		})),
	};
	const f = fixture([Promise.resolve(splitResponse)]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
});

test("email-address-like model output is rejected before normalization and not disclosed", async () => {
	const address = ["pi-tmux", "@", "example", ".", "invalid"].join("");
	const fragments = ["pi-tmux", "@", "example", ".", "invalid"];
	const splitResponse = {
		...response(""),
		content: fragments.map((text, index) => ({
			type: "text",
			text,
			textSignature: JSON.stringify({ v: 1, id: `email-${index}`, phase: "final_answer" }),
		})),
	};
	const f = fixture([Promise.resolve(splitResponse)]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
	expect(f.warnings.join(" ")).not.toContain(address);
});

test("ordinary security-themed titles without credential values remain valid", async () => {
	const f = fixture([Promise.resolve(response("review bearer auth flow"))]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("review bearer auth flow");
	expect(f.warnings).toEqual([]);
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

test("an aborted run is settled and waiting, without implying task success", async () => {
	const f = fixture([]);
	await f.handlers.get("agent_settled")!({ type: "agent_settled", aborted: true }, f.ctx);
	expect(f.state.title).toBe("* existing task");
	expect(f.state.sessionTitle).toBe("* My Session");
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

	const largePrompt = "NEW_PROMPT".repeat(1_000);
	const large = buildNamingContext([
		{ role: "compactionSummary", summary: "SUMMARY".repeat(2_000) },
		...Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `${i}:` + "x".repeat(10_000) })),
	] as any, largePrompt);
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const suffixLength = Math.floor(retainedLength / 2);
	expect(large.length).toBeLessThanOrEqual(MAX_CONTEXT_LENGTH);
	expect(large).toStartWith("summary: SUMMARY");
	expect(large).toContain("user: 29:");
	expect(large.endsWith(
		`user: ${largePrompt.slice(0, prefixLength)}\n${marker}\n${largePrompt.slice(-suffixLength)}`,
	)).toBe(true);
});

test("naming context does not read text from history older than its retained window", () => {
	let readDiscardedContent = false;
	const discarded = { role: "user" } as any;
	Object.defineProperty(discarded, "content", {
		get() {
			readDiscardedContent = true;
			throw new Error("Discarded history should not be copied");
		},
	});
	const recent = Array.from({ length: MAX_HISTORY_MESSAGES }, (_, i) => ({
		role: "user", content: `recent-${i}`,
	}));

	const context = buildNamingContext([discarded, ...recent] as any);
	expect(context).toContain("recent-0");
	expect(context).toContain(`recent-${MAX_HISTORY_MESSAGES - 1}`);
	expect(context).not.toContain("Discarded");
	expect(readDiscardedContent).toBe(false);
});

test("naming context stops reading text after its per-entry bound", () => {
	let readUnneededText = false;
	const laterBlock = { type: "text" } as any;
	Object.defineProperty(laterBlock, "text", {
		get() {
			readUnneededText = true;
			throw new Error("Text beyond the bounded prefix should not be read");
		},
	});
	const context = buildNamingContext([{
		role: "user",
		content: [{ type: "text", text: "x".repeat(1_001) }, laterBlock],
	}] as any);

	expect(context).toBe("user: " + "x".repeat(1_000));
	expect(readUnneededText).toBe(false);
});

test("naming context stops before later blocks when the exact bound ends in non-whitespace", () => {
	let readUnneededText = false;
	const laterBlock = { type: "text" } as any;
	Object.defineProperty(laterBlock, "text", {
		get() {
			readUnneededText = true;
			throw new Error("Text beyond the bounded prefix should not be read");
		},
	});
	const context = buildNamingContext([{
		role: "user",
		content: [{ type: "text", text: "x".repeat(1_000) }, laterBlock],
	}] as any);

	expect(context).toBe("user: " + "x".repeat(1_000));
	expect(readUnneededText).toBe(false);
});

test("naming context stops at a whitespace-ending bound without scanning later blocks", () => {
	let readUnneededText = false;
	const laterBlock = { type: "text" } as any;
	Object.defineProperty(laterBlock, "text", {
		get() {
			readUnneededText = true;
			throw new Error("Text beyond the bounded prefix should not be read");
		},
	});
	const context = buildNamingContext([{
		role: "user",
		content: [{ type: "text", text: "x".repeat(999) + " " }, laterBlock],
	}] as any);

	expect(context).toBe("user: " + "x".repeat(999));
	expect(readUnneededText).toBe(false);
});

test("naming context does not split Unicode characters at a text limit", () => {
	let readUnneededText = false;
	const laterBlock = { type: "text" } as any;
	Object.defineProperty(laterBlock, "text", {
		get() {
			readUnneededText = true;
			throw new Error("Text beyond the bounded prefix should not be read");
		},
	});
	const context = buildNamingContext([{
		role: "user",
		content: [{ type: "text", text: "x".repeat(999) + "😀" }, laterBlock],
	}] as any);

	expect(context).toBe("user: " + "x".repeat(999));
	expect(readUnneededText).toBe(false);
});

test("bounded naming text preserves Unicode trimming and text-block separators", () => {
	const context = buildNamingContext([
		{ role: "compactionSummary", summary: "\u00a0\ufeffDeploy safely\u00a0 " + " ".repeat(1_200) },
		{ role: "user", content: [{ type: "text", text: "\u00a0Fix" }, { type: "text", text: " auth tests\ufeff\n" }] },
	] as any, "\ufeffcontinue\u00a0");

	expect(context).toBe("summary: Deploy safely\n\nuser: Fix\n auth tests\n\nuser: continue");
});

test("Unicode NEL whitespace is ignored at input and trimmed from naming context", async () => {
	const f = fixture();
	f.input("\u0085");
	await settle();
	expect(f.requests).toEqual([]);
	expect(f.calls).toEqual([]);

	const context = buildNamingContext([
		{ role: "user", content: "\u0085task\u0085" },
	] as any, "\u0085continue\u0085");
	expect(context).toBe("user: task\n\nuser: continue");
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

test("a cancelled naming result that fails during rename is not reused by later status updates", async () => {
	const gate = deferred();
	let held = false;
	const f = fixture([Promise.resolve(response("Removed task"))], async (args) => {
		if (!held && args[0] === "rename-window") {
			held = true;
			await gate.promise;
			throw new Error("Synthetic stale rename failure");
		}
	});
	f.input("Original task");
	await settle();
	expect(held).toBe(true);

	f.messages.length = 0;
	await f.emit("session_compact");
	gate.resolve(response(""));
	await settle();
	await f.emit("agent_start");
	await settle();

	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window" && args[4].includes("removed task"))).toHaveLength(1);
	expect(f.warnings).toEqual([]);
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

test("a failed current naming rename remains available for a later sync retry", async () => {
	let fail = true;
	const f = fixture([Promise.resolve(response("Current task"))], async (args) => {
		if (fail && args[0] === "rename-window" && args[4].includes("current task")) {
			fail = false;
			throw new Error("Synthetic transient rename failure");
		}
	});
	f.input("Task");
	await settle();
	await f.refresh("status");
	expect(f.notices.at(-1)).toContain("Naming request: ready to apply");
	await f.refresh("sync");

	expect(f.state.title).toBe("current task");
	expect(f.requests).toHaveLength(1);
	expect(f.warnings).toHaveLength(1);
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

test("session-projection failures cancel stale naming and allow later retries", async () => {
	const stale = deferred();
	const f = fixture([stale.promise, Promise.resolve(response("fresh task"))]);
	f.messages.push({ role: "user", content: "Original task" });
	await f.emit("session_start");
	expect(f.requests).toHaveLength(1);

	const sessionManager = f.ctx.sessionManager as any;
	sessionManager.buildSessionProjection = () => { throw new Error("Synthetic private projection failure"); };
	expect(() => f.emit("session_compact")).not.toThrow();
	expect(f.requests[0].options.signal.aborted).toBe(true);
	expect(f.warnings).toEqual(["Pi session context could not be read. The tmux title was not updated."]);
	stale.resolve(response("stale title"));
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.warnings.join("\n")).not.toContain("Synthetic private projection failure");
	await f.refresh();
	expect(f.warnings).toHaveLength(2);
	expect(f.notices).toEqual([]);

	sessionManager.buildSessionProjection = () => ({ messages: f.messages });
	await f.emit("session_compact");
	await settle();
	expect(f.requests).toHaveLength(2);
	expect(f.state.title).toBe("fresh task");
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
	expect(parseNamingModel("custom.provider+region/model")).toEqual({ provider: "custom.provider+region", id: "model" });
	expect(parseNamingModel(" OFF ")).toBeNull();
	const longestSetting = `${"p".repeat(254)}/m`;
	expect(longestSetting).toHaveLength(256);
	expect(parseNamingModel(longestSetting)).toEqual({ provider: "p".repeat(254), id: "m" });
	const oversizedSetting = `${"p".repeat(255)}/m`;
	expect(oversizedSetting).toHaveLength(257);
	for (const value of ["model", "/model", "provider/", "bad provider/model", "provider/a\nb", oversizedSetting]) {
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

test.each([
	{ prefix: "", values: ["status", "sync", "set ", "auto"] },
	{ prefix: "s", values: ["status", "sync", "set "] },
	{ prefix: "st", values: ["status"] },
	{ prefix: "sy", values: ["sync"] },
	{ prefix: "se", values: ["set "] },
	{ prefix: "a", values: ["auto"] },
	{ prefix: "status", values: ["status"] },
	{ prefix: "sync", values: ["sync"] },
	{ prefix: "set", values: ["set "] },
	{ prefix: "auto", values: ["auto"] },
	{ prefix: " \ts", values: ["status", "sync", "set "] },
	{ prefix: " \t", values: ["status", "sync", "set ", "auto"] },
])("argument completion matches only supported subcommands: %j", ({ prefix, values }) => {
	const f = fixture();
	const items = f.complete(prefix);
	expect(items.map((item: any) => item.value)).toEqual(values);
	expect(items.every((item: any) => item.label && item.description)).toBe(true);
	expect(f.calls).toEqual([]);
	expect(f.requests).toEqual([]);
});

test.each(["unknown", "S", "set ", "set private title", "set\n", "set\tname", "status ", "status extra", "sync extra", "auto extra", "set café", "\u001b"])("argument completion leaves free-form titles and invalid prefixes alone: %j", (prefix) => {
	const f = fixture();
	expect(f.complete(prefix)).toBeNull();
	expect(f.calls).toEqual([]);
	expect(f.requests).toEqual([]);
});

test("argument completion needs no context, credentials, tmux target, or valid naming config", () => {
	process.env.PI_TMUX_MODEL = "synthetic invalid configuration";
	delete process.env.TMUX_PANE;
	const f = fixture();
	Object.defineProperty(f.ctx, "sessionManager", { get: () => { throw new Error("Must not access dialogue"); } });
	Object.defineProperty(f.ctx, "modelRegistry", { get: () => { throw new Error("Must not access models or auth"); } });
	expect(f.complete("s")).toHaveLength(3);
	expect(f.complete("set synthetic private title")).toBeNull();
	expect(f.notices).toEqual([]);
	expect(f.warnings).toEqual([]);
	expect(f.calls).toEqual([]);
	expect(f.requests).toEqual([]);
});

test("argument completion preserves pending naming and never includes task text", async () => {
	const work = deferred();
	const f = fixture([work.promise]);
	f.input("synthetic private task text");
	await settle();
	const before = f.calls.length;
	expect(JSON.stringify(f.complete())).not.toContain("synthetic private task text");
	expect(f.calls).toHaveLength(before);
	expect(f.requests).toHaveLength(1);
	expect(f.requests[0].options.signal.aborted).toBe(false);
	work.resolve(response("current task"));
	await settle();
	expect(f.state.title).toBe("current task");
});

test("argument completion preserves pins and returns independent suggestion objects", async () => {
	const f = fixture();
	await f.refresh("set synthetic private pin");
	const before = f.calls.length;
	const items = f.complete();
	expect(JSON.stringify(items)).not.toContain("synthetic private pin");
	items[0].value = "corrupted";
	items[0].description = "corrupted";
	items.push({ value: "extra", label: "extra" });
	expect(f.complete().map((item: any) => item.value)).toEqual(["status", "sync", "set ", "auto"]);
	expect(f.complete()[0].description).toBe("Show read-only title diagnostics");
	expect(f.calls).toHaveLength(before);
	expect(f.state.title).toBe("synthetic private pin");
	f.input("another task");
	await settle();
	expect(f.requests).toEqual([]);
	expect(f.state.title).toBe("synthetic private pin");
});

test.each([
	{ prefix: "st", value: "status", expected: "/tmux-title status" },
	{ prefix: "sy", value: "sync", expected: "/tmux-title sync" },
	{ prefix: "se", value: "set ", expected: "/tmux-title set " },
	{ prefix: "a", value: "auto", expected: "/tmux-title auto" },
	{ prefix: "  se", value: "set ", expected: "/tmux-title set " },
])("Pi's completion provider inserts a runnable argument without a literal placeholder: %j", async ({ prefix, value, expected }) => {
	const f = fixture();
	const provider = new CombinedAutocompleteProvider([{ name: "tmux-title", getArgumentCompletions: f.complete }], process.cwd());
	const line = "/tmux-title " + prefix;
	const suggestions = await provider.getSuggestions([line], 0, line.length, { force: false, signal: new AbortController().signal });
	expect(suggestions).not.toBeNull();
	const item = suggestions!.items.find((entry) => entry.value === value)!;
	const result = provider.applyCompletion([line], 0, line.length, item, suggestions!.prefix);
	expect(result.lines).toEqual([expected]);
	expect(result.cursorCol).toBe(expected.length);
	expect(result.lines[0]).not.toContain("<name>");
	expect(f.calls).toEqual([]);
	expect(f.requests).toEqual([]);
});

test("Pi's provider does not replace a partially entered manual title", async () => {
	const f = fixture();
	const provider = new CombinedAutocompleteProvider([{ name: "tmux-title", getArgumentCompletions: f.complete }], process.cwd());
	const line = "/tmux-title set a custom title";
	expect(await provider.getSuggestions([line], 0, line.length, { force: false, signal: new AbortController().signal })).toBeNull();
	expect(f.calls).toEqual([]);
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

test.each(["display-message", "set-option", "rename-window"])("manual title failure at %s does not report success and sync retries the retained pin", async (stage) => {
	let failed = false;
	const f = fixture(undefined, async (args) => {
		if (!failed && args[0] === stage) { failed = true; throw new Error("Synthetic tmux failure"); }
	});
	await f.refresh("set retained pin");
	expect(failed).toBe(true);
	expect(f.notices).toEqual([]);
	expect(f.warnings).toHaveLength(1);
	await f.refresh("status");
	expect(f.notices.at(-1)).toContain("Title mode: manual");
	await f.refresh("sync");
	expect(f.state.title).toBe("retained pin");
	expect(f.notices.at(-1)).toBe("tmux title and waiting markers synchronized.");
	expect(f.requests).toEqual([]);
});

test.each(["different title", "same title", "reload"])("superseded manual commands do not send stale confirmations: %s", async (replacement) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let held = false;
	const f = fixture(undefined, async (args) => {
		if (!held && args[0] === "display-message") { held = true; await gate; }
	});
	const older = f.refresh("set same title");
	await settle();
	const newer = replacement === "reload" ? f.emit("session_shutdown", "reload") : f.refresh("set " + replacement);
	release();
	await older;
	await newer;
	expect(f.notices).toHaveLength(replacement === "reload" ? 0 : 1);
	if (replacement !== "reload") expect(f.state.title).toBe(replacement);
	expect(f.warnings).toEqual([]);
});

test("manual commands superseded during a rename only confirm the newer pin", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let held = false;
	const f = fixture(undefined, async (args) => {
		if (!held && args[0] === "rename-window") { held = true; await gate; }
	});
	const older = f.refresh("set first pin");
	await settle();
	expect(held).toBe(true);
	const newer = f.refresh("set second pin");
	release();
	await older;
	await newer;
	expect(f.writes).toEqual(["first pin", "second pin"]);
	expect(f.notices).toHaveLength(1);
	expect(f.state.title).toBe("second pin");
});

test.each(["set", "sync"])("%s confirmation rechecks the revision after the completed update resolves", async (command) => {
	let statusStarted = false;
	let racing = false;
	const f = fixture(undefined, async (args) => {
		if (!racing || args[0] !== "rename-window") return;
		// Cross the driver, write, queue catch, and result continuations, then
		// supersede the completed update before the command can confirm it.
		const schedule = (remaining: number) => queueMicrotask(() => {
			if (remaining > 1) schedule(remaining - 1);
			else { statusStarted = true; void f.emit("agent_start"); }
		});
		schedule(5);
	});
	if (command === "sync") {
		await f.refresh("set race pin");
		f.notices.length = 0;
		f.calls.length = 0;
		f.state.title = "external replacement";
	}
	racing = true;
	await f.refresh(command === "set" ? "set race pin" : "sync");
	await settle();
	expect(statusStarted).toBe(true);
	expect(f.state.title).toBe("race pin");
	expect(f.calls.filter((args) => args[0] === "set-option")).toHaveLength(2);
	expect(f.notices).toEqual([]);
});

test.each([undefined, "off", "example invalid setting"])("sync makes no model, credential or projection calls: %j", async (setting) => {
	if (setting === undefined) delete process.env.PI_TMUX_MODEL;
	else process.env.PI_TMUX_MODEL = setting;
	const f = fixture();
	Object.defineProperty(f.ctx, "sessionManager", { get: () => { throw new Error("Must not collect dialogue"); } });
	Object.defineProperty(f.ctx, "modelRegistry", { get: () => { throw new Error("Must not access auth or models"); } });
	f.state.title = "Custom Café Title";
	await f.refresh("sync");
	expect(f.state.title).toBe("Custom Café Title");
	expect(f.writes).toEqual([]);
	expect(f.requests).toEqual([]);
	expect(f.state.activePanes.get("%1")).toBe("1");
	expect(f.notices).toEqual(["tmux title and waiting markers synchronized."]);
	expect(f.warnings).toEqual([]);
});

test("sync reapplies a pin and preserves local waiting and peer flags", async () => {
	const f = fixture();
	await f.refresh("set pinned task");
	await f.emit("agent_settled");
	f.state.waitingPanes.set("%2", "1");
	f.state.waitingPanes.set("%3", "1");
	f.state.otherWindowPanes.add("%3");
	f.state.title = "external replacement";
	await f.refresh("sync");
	expect(f.state.title).toBe("* pinned task");
	expect(f.state.waitingPanes).toEqual(new Map([["%1", "1"], ["%2", "1"], ["%3", "1"]]));
	await f.refresh("status");
	expect(f.notices.at(-1)).toContain("Title mode: manual");
	expect(f.notices.at(-1)).toContain("Local waiting: yes");
	expect(f.requests).toEqual([]);
});

test("sync leaves pending naming alive and its later result can update the title", async () => {
	const work = deferred();
	const f = fixture([work.promise]);
	f.input("synthetic task");
	await settle();
	await f.refresh("sync");
	expect(f.requests).toHaveLength(1);
	expect(f.requests[0].options.signal.aborted).toBe(false);
	work.resolve(response("late ai title"));
	await settle();
	expect(f.state.title).toBe("late ai title");
});

test("sync can apply a completed current candidate without another naming request", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let held = false;
	const f = fixture(undefined, async (args) => {
		if (!held && args[0] === "display-message") { held = true; await gate; }
	});
	f.input("synthetic task");
	await settle();
	const sync = f.refresh("sync");
	release();
	await sync;
	await settle();
	expect(f.state.title).toBe("fix auth tests");
	expect(f.requests).toHaveLength(1);
	expect(f.notices).toEqual(["tmux title and waiting markers synchronized."]);
});

test("sync failures never report success and explicit repeats can warn again", async () => {
	const f = fixture(undefined, async () => { throw new Error("Synthetic private error details"); });
	await f.refresh("sync");
	await f.refresh("sync");
	expect(f.notices).toEqual([]);
	expect(f.warnings).toHaveLength(2);
	expect(f.warnings.join("\n")).not.toContain("Synthetic private error details");
});

test.each(["new status", "reload"])("superseded sync commands do not confirm stale updates: %s", async (replacement) => {
	process.env.PI_TMUX_MODEL = "off";
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let held = false;
	const f = fixture(undefined, async (args) => {
		if (!held && args[0] === "set-option") { held = true; await gate; }
	});
	const sync = f.refresh("sync");
	await settle();
	const next = replacement === "reload" ? f.emit("session_shutdown", "reload") : f.emit("agent_settled");
	release();
	await sync;
	await next;
	expect(f.notices).toEqual([]);
	expect(f.warnings).toEqual([]);
});

test("sync does not report success when continuous moves exhaust its stabilization bound", async () => {
	let reads = 0;
	const f = fixture(undefined, async (args) => {
		if (args[0] === "display-message") f.state.window = `@${++reads}`;
	});
	await f.refresh("sync");
	expect(f.calls.filter((args) => args[0] === "set-option")).toHaveLength(4);
	expect(f.notices).toEqual([]);
	expect(f.requests).toEqual([]);
});

test("sync does not change automatic title mode", async () => {
	const f = fixture();
	await f.refresh("sync");
	f.input("a new task");
	await settle();
	expect(f.requests).toHaveLength(1);
	expect(f.state.title).toBe("fix auth tests");
});

test.each(["print", "json", "rpc"])("sync cannot write in %s mode", async (mode) => {
	const f = fixture();
	(f.ctx as any).mode = mode;
	await f.refresh("sync");
	expect(f.calls).toEqual([]);
	expect(f.requests).toEqual([]);
});

test("sync rejects invalid targets and trailing arguments but set sync remains a title", async () => {
	const f = fixture();
	await f.refresh("sync extra");
	expect(f.calls).toEqual([]);
	process.env.TMUX_PANE = "%1; unsafe";
	await f.refresh("sync");
	expect(f.calls).toEqual([]);
	process.env.TMUX_PANE = "%1";
	await f.refresh("set sync");
	expect(f.state.title).toBe("sync");
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

test.each([
	{ setting: undefined, expected: "configured" },
	{ setting: "off", expected: "off" },
	{ setting: "example invalid configuration", expected: "invalid configuration" },
	{ setting: "router/vendor/example-model", expected: "configured" },
])("status is read-only and reports configuration without dialogue or registry access: %j", async ({ setting, expected }) => {
	if (setting === undefined) delete process.env.PI_TMUX_MODEL;
	else process.env.PI_TMUX_MODEL = setting;
	const f = fixture();
	Object.defineProperty(f.ctx, "sessionManager", { get: () => { throw new Error("Must not collect dialogue"); } });
	Object.defineProperty(f.ctx, "modelRegistry", { get: () => { throw new Error("Must not access credentials or models"); } });
	f.state.title = "synthetic private title";
	f.state.sessionTitle = "synthetic private session name";
	await f.refresh("status");
	expect(f.calls).toEqual([["display-message", "-p", "-t", "%1", STATUS_INFO_FORMAT]]);
	expect(f.requests).toEqual([]);
	expect(f.writes).toEqual([]);
	expect(f.state.waitingPanes.size).toBe(0);
	expect(f.state.activePanes.size).toBe(0);
	expect(f.notices[0]).toContain("AI naming: " + expected);
	expect(f.notices[0]).toContain("Targets: pane %1, window @2, session $0");
	expect(f.notices[0]).toContain("Pending move repairs: windows 0, sessions 0");
	expect(f.notices[0]).not.toContain(f.state.title);
	expect(f.notices[0]).not.toContain(f.state.sessionTitle);
	if (setting && setting !== "off") expect(f.notices[0]).not.toContain(setting);
	expect(f.warnings).toEqual([]);
});

test.each([
	{ pane: false, peer: false, elsewhere: false, flags: "pane no, window no, session no" },
	{ pane: true, peer: false, elsewhere: false, flags: "pane yes, window yes, session yes" },
	{ pane: false, peer: true, elsewhere: false, flags: "pane no, window yes, session yes" },
	{ pane: false, peer: false, elsewhere: true, flags: "pane no, window no, session yes" },
])("status reports server waiting flags separately from local state: %j", async ({ pane, peer, elsewhere, flags }) => {
	const f = fixture();
	f.state.waitingPanes.set("%1", pane ? "1" : "0");
	f.state.waitingPanes.set("%2", peer ? "1" : "0");
	f.state.waitingPanes.set("%3", elsewhere ? "1" : "0");
	f.state.otherWindowPanes.add("%3");
	await f.refresh("status");
	expect(f.notices[0]).toContain("Waiting flags: " + flags);
	expect(f.notices[0]).toContain("Local waiting: no");
	expect(f.calls).toHaveLength(1);
	expect(f.writes).toEqual([]);
});

test("status preserves manual pins and waiting state", async () => {
	const f = fixture();
	await f.refresh("set pinned task");
	await f.emit("agent_settled");
	const previousWrites = [...f.writes];
	const previousCalls = f.calls.length;
	await f.refresh("status");
	expect(f.notices.at(-1)).toContain("Title mode: manual");
	expect(f.notices.at(-1)).toContain("Local waiting: yes");
	expect(f.notices.at(-1)).toContain("Waiting flags: pane yes, window yes, session yes");
	expect(f.writes).toEqual(previousWrites);
	expect(f.calls.slice(previousCalls)).toEqual([["display-message", "-p", "-t", "%1", STATUS_INFO_FORMAT]]);
	f.input("another task");
	await settle();
	expect(f.state.title).toBe("pinned task");
	expect(f.requests).toHaveLength(0);
});

test("status does not cancel or wait for a pending naming request", async () => {
	const pending = deferred();
	const f = fixture([pending.promise]);
	f.input("synthetic task");
	await settle();
	await f.refresh("status");
	expect(f.notices.at(-1)).toContain("Naming request: pending");
	expect(f.requests).toHaveLength(1);
	expect(f.requests[0].options.signal.aborted).toBe(false);
	pending.resolve(response("completed task"));
	await settle();
	expect(f.state.title).toBe("completed task");
});

test("status reports completed model output waiting to be applied without changing it", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let held = false;
	const f = fixture(undefined, async (args) => {
		if (!held && args[0] === "display-message" && args[4] === WINDOW_INFO_FORMAT) {
			held = true;
			await gate;
		}
	});
	f.input("synthetic task");
	await settle();
	try {
		expect(held).toBe(true);
		await f.refresh("status");
		expect(f.notices.at(-1)).toContain("Naming request: ready to apply");
		expect(f.writes).toEqual([]);
	} finally { release(); }
	await settle();
	expect(f.state.title).toBe("fix auth tests");
	expect(f.requests).toHaveLength(1);
});

test.each([
	"$0\t@2\t2\t0\t0", "$0\t@2\t0\tx\t0", "$0\t@2\t0\t0\t9",
	"home\t@2\t0\t0\t0", "$0\t-t\t0\t0\t0", "$0\t@2\t0\t0",
	"$0\t@2\t0\t0\t0\textra",
])("invalid status snapshots are contained without exposing their contents: %j", async (info) => {
	const f = fixture();
	f.state.statusInfo = info;
	await f.refresh("status");
	expect(f.notices).toEqual([]);
	expect(f.warnings).toEqual(["tmux status could not be read. Check tmux."]);
	expect(f.calls).toHaveLength(1);
	expect(f.requests).toHaveLength(0);
	expect(f.writes).toEqual([]);
});

test("status failures do not consume or reset the automatic warning budget", async () => {
	const f = fixture(undefined, async () => { throw new Error("synthetic private error details"); });
	await f.refresh("status");
	expect(f.warnings).toEqual(["tmux status could not be read. Check tmux."]);
	await f.emit("agent_settled");
	const warnings = f.warnings.length;
	expect(warnings).toBe(2);
	await f.refresh("status");
	expect(f.warnings).toHaveLength(warnings + 1);
	await f.emit("agent_settled");
	expect(f.warnings).toHaveLength(warnings + 1);
	expect(f.warnings.join("\n")).not.toContain("synthetic private error details");
});

test("reload cancels a pending status snapshot without notifying the disposed runtime", async () => {
	process.env.PI_TMUX_MODEL = "off";
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let statusSignal: AbortSignal | undefined;
	const f = fixture(undefined, async (args, signal) => {
		if (args[4] === STATUS_INFO_FORMAT) { statusSignal = signal; await gate; }
	});
	const status = f.refresh("status");
	await settle();
	await f.emit("session_shutdown", "reload");
	expect(statusSignal?.aborted).toBe(true);
	release();
	await status;
	expect(f.notices).toEqual([]);
	expect(f.warnings).toEqual([]);
});

test.each(["print", "json", "rpc"])("status cannot query tmux in %s mode", async (mode) => {
	const f = fixture();
	(f.ctx as any).mode = mode;
	await f.refresh("status");
	expect(f.calls).toEqual([]);
	expect(f.requests).toEqual([]);
	expect(f.warnings[0]).toContain("interactive Pi inside tmux");
});

test.each([undefined, "@2", "%1; unsafe"])("status rejects a missing or invalid pane ID: %j", async (pane) => {
	const f = fixture();
	if (pane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = pane;
	await f.refresh("status");
	expect(f.calls).toEqual([]);
	expect(f.warnings[0]).toContain("interactive Pi inside tmux");
});

test("status does not accept trailing arguments or reserve set status as a command", async () => {
	const f = fixture();
	await f.refresh("status extra");
	expect(f.calls).toEqual([]);
	expect(f.warnings[0]).toContain("auto | status");
	await f.refresh("set status");
	expect(f.state.title).toBe("status");
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
