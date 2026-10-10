import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { getEventListeners } from "node:events";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piTmux, { buildNamingContext, buildWindowTitleFormat, WINDOW_INFO_FORMAT, WINDOW_WAITING_FORMAT, cleanTitle, formatTitle, parseNamingModel, MAX_CONTEXT_LENGTH, MAX_HISTORY_MESSAGES, MAX_PROMPT_LENGTH, MAX_TITLE_LENGTH, READY_PREFIX, SESSION_TITLE_FORMAT, WAITING_OPTION, ACTIVE_OPTION, QUIT_TITLE_FORMAT, type RunTmux } from "../index";
import { STATUS_SNAPSHOT_FORMAT } from "../src/tmux.ts";
import { hasSensitiveNamingContext, hasSensitiveOutput } from "../src/naming.ts";
import {
	buildQuitTitleFormat,
	buildWindowBaseQuitTitleFormats,
	PRESERVED_WINDOW_TITLE_FORMAT,
	WINDOW_BASE_NAME_OPTION,
	WINDOW_BASE_NAME_TITLE_FORMAT,
	WINDOW_BASE_NAME_UPDATE_FORMAT,
	WINDOW_TITLE_MARKED_OPTION,
	WINDOW_TITLE_MARKED_VALUE_FORMAT,
} from "../src/tmux.ts";

let originalPane: string | undefined;
let originalModel: string | undefined;
let originalIdleTitle: string | undefined;
beforeEach(() => {
	originalPane = process.env.TMUX_PANE;
	originalModel = process.env.PI_TMUX_MODEL;
	originalIdleTitle = process.env.PI_TMUX_IDLE_TITLE;
	process.env.TMUX_PANE = "%1";
	delete process.env.PI_TMUX_MODEL;
	delete process.env.PI_TMUX_IDLE_TITLE;
});
afterEach(() => {
	if (originalPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = originalPane;
	if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
	else process.env.PI_TMUX_MODEL = originalModel;
	if (originalIdleTitle === undefined) delete process.env.PI_TMUX_IDLE_TITLE;
	else process.env.PI_TMUX_IDLE_TITLE = originalIdleTitle;
});

const response = (text: string, stopReason = "stop") => ({
	content: [{ type: "text", text }],
	stopReason,
});

function basicAuthorizationHeader(header: "Authorization" | "Proxy-Authorization", userPass: string): string {
	return `${header}: Basic ${Buffer.from(userPass).toString("base64")}`;
}

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
	let idleTitle = "zsh";
	const state = {
		window: "@2", title: "existing task", session: "$0", sessionTitle: "My Session",
		windowInfo: undefined as string | undefined,
		statusInfo: undefined as string | undefined,
		windowBaseName: undefined as string | undefined,
		windowTitleMarked: undefined as string | undefined,
		waitingPanes: new Map<string, string>(),
		activePanes: new Map<string, string>(),
		otherWindowPanes: new Set<string>(),
	};
	const windowWaiting = () => [...state.waitingPanes].some(([pane, value]) => value === "1" && !state.otherWindowPanes.has(pane));
	const renderTitle = (format: string) => {
		if (format === PRESERVED_WINDOW_TITLE_FORMAT) {
			return (windowWaiting() ? READY_PREFIX : "") + state.title.replace(/^\* /, "");
		}
		if (format === buildQuitTitleFormat(idleTitle)) {
			const hasPeer = [...state.activePanes, ...state.waitingPanes].some(([pane, value]) => value === "1" && !state.otherWindowPanes.has(pane));
			if (!hasPeer) return formatTitle(idleTitle, windowWaiting());
			const title = state.title.replace(/^\* /, "");
			return windowWaiting() ? READY_PREFIX + title : title;
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
		if (args[0] === "display-message" && args[4] === STATUS_SNAPSHOT_FORMAT) {
			return state.statusInfo ?? `123\t${state.session}\t${state.window}\t${state.waitingPanes.get("%1") === "1" ? "1" : "0"}\t${windowWaiting() ? "1" : "0"}\t${[...state.waitingPanes.values()].includes("1") ? "1" : "0"}`;
		}
		if (args[0] === "display-message") return state.windowInfo ?? `${state.session}\t${state.window}\t${windowWaiting() ? "1" : "0"}\t${state.title}`;
		if (args[0] === "show-options" && args.at(-1) === WINDOW_TITLE_MARKED_OPTION) return state.windowTitleMarked ?? "";
		if (args[0] === "set-option" && args.includes(WINDOW_BASE_NAME_OPTION)) {
			const baseIndex = args.indexOf(WINDOW_BASE_NAME_OPTION);
			const baseValue = args[baseIndex + 1];
			const quitFormats = buildWindowBaseQuitTitleFormats(idleTitle);
			if (baseValue === quitFormats.baseName) {
				const hasPeer = [...state.activePanes, ...state.waitingPanes].some(([pane, value]) => value === "1" && !state.otherWindowPanes.has(pane));
				state.windowBaseName = hasPeer
					? state.windowBaseName && (state.title === state.windowBaseName || state.title === READY_PREFIX + state.windowBaseName)
						? state.windowBaseName
						: state.windowTitleMarked === "marked" && state.title.startsWith(READY_PREFIX)
							? state.title.slice(READY_PREFIX.length) : state.title
					: idleTitle;
			} else if (baseValue === WINDOW_BASE_NAME_UPDATE_FORMAT) {
				state.windowBaseName = state.windowTitleMarked === "marked" && state.title.startsWith(READY_PREFIX)
					? state.title.slice(READY_PREFIX.length)
					: state.windowBaseName && (state.title === state.windowBaseName || state.title === READY_PREFIX + state.windowBaseName)
						? state.windowBaseName : state.title;
			} else state.windowBaseName = baseValue;
			const action = args.find((value) => value.startsWith("rename-window -t "));
			if (action) {
				const titleFormat = action.match(/ -- '([\s\S]*)'$/)?.[1];
				expect(titleFormat).toBeDefined();
				if (titleFormat === quitFormats.title) {
					const hasPeer = [...state.activePanes, ...state.waitingPanes].some(([pane, value]) => value === "1" && !state.otherWindowPanes.has(pane));
					state.title = hasPeer
						? (windowWaiting() ? READY_PREFIX : "") + (state.windowBaseName ?? "")
						: formatTitle(idleTitle, windowWaiting());
				} else if (titleFormat === WINDOW_BASE_NAME_TITLE_FORMAT) {
					state.title = windowWaiting()
						? `${READY_PREFIX}${state.windowBaseName || "pi"}`
						: state.windowBaseName ?? "";
				} else state.title = renderTitle(titleFormat!);
			}
			state.windowTitleMarked = args.at(-1) === WINDOW_TITLE_MARKED_VALUE_FORMAT
				? windowWaiting() ? "marked" : "unmarked"
				: "transition";
			return "";
		}
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
	const load = () => {
		const setting = process.env.PI_TMUX_IDLE_TITLE ?? "zsh";
		idleTitle = hasSensitiveOutput(setting) ? "zsh" : cleanTitle(setting) || "zsh";
		return piTmux({
			on: (event: string, handler: Function) => handlers.set(event, handler),
			registerCommand: (name: string, command: { handler: Function; getArgumentCompletions?: Function }) => commands.set(name, command),
		} as unknown as ExtensionAPI, tmux);
	};
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

test.each([-1, -24])("returns an empty title for a negative length limit: %i", (maxLength) => {
	expect(cleanTitle("fix auth", maxLength)).toBe("");
});

test("caps names at 24 ASCII cells, preferably on a word boundary", () => {
	expect(cleanTitle("Investigate authentication failures")).toBe("investigate");
	expect(cleanTitle("x".repeat(80))).toHaveLength(MAX_TITLE_LENGTH);
	expect(cleanTitle("x".repeat(24))).toHaveLength(MAX_TITLE_LENGTH);
	expect(cleanTitle("unbounded title", Number.MAX_SAFE_INTEGER)).toBe("unbounded title");
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

test("a descriptive first prompt can be titled without answering it", async () => {
	const prompt = "Explain in two short sentences what a tmux window title is. Do not use any tools.";
	const f = fixture([Promise.resolve(response("explain tmux titles"))]);
	f.input(prompt);
	await settle();
	expect(f.requests[0].context.messages).toEqual([{ role: "user", content: `user: ${prompt}`, timestamp: expect.any(Number) }]);
	expect(f.state.title).toBe("explain tmux titles");
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

test("balances oversized prompt context and disables reasoning and provider retries", async () => {
	const f = fixture();
	f.input("x".repeat(10_000));
	await settle();
	const request = f.requests[0];
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const suffixLength = Math.floor(retainedLength / 2);
	expect(request.context.messages).toHaveLength(1);
	expect(request.context.systemPrompt).toContain("Ignore requested answer format, length, or style");
	expect(request.context.systemPrompt).toContain("Do not answer or restate the user's request; give it a concise task label");
	expect(request.context.systemPrompt).toContain("explain tmux titles or fix auth tests");
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

test("does not split a supplementary character at the end of a retained prompt prefix", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const suffixLength = Math.floor(retainedLength / 2);
	const prompt = `${"x".repeat(prefixLength - 1)}😀${"y".repeat(10_000)}`;
	const context = buildNamingContext([], prompt);
	const [prefix, suffix] = context.slice("user: ".length).split(`\n${marker}\n`);
	expect(prefix).toBe(`${"x".repeat(prefixLength - 1)}😀`);
	expect(suffix).toBe("y".repeat(suffixLength - 1));
	expect(context.length).toBeLessThanOrEqual("user: ".length + MAX_PROMPT_LENGTH);
});

test("keeps both retained prompt boundaries Unicode-safe together", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const suffixLength = Math.floor(retainedLength / 2);
	const promptLength = 3_000;
	const suffixStart = promptLength - suffixLength;
	const prompt = `${"x".repeat(prefixLength - 1)}😀${"x".repeat(suffixStart - prefixLength - 1)}😀${"y".repeat(promptLength - suffixStart - 2)}`;
	const context = buildNamingContext([], prompt);
	const [prefix, suffix] = context.slice("user: ".length).split(`\n${marker}\n`);
	expect(prefix).toBe(`${"x".repeat(prefixLength - 1)}😀`);
	expect(suffix).toBe("y".repeat(promptLength - suffixStart - 2));
	expect(context.length).toBeLessThanOrEqual("user: ".length + MAX_PROMPT_LENGTH);
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

test("the original deadline also aborts a hanging title correction request", async () => {
	await withNamingTimers(async (timers, cleared) => {
		const retry = deferred();
		const f = fixture([
			Promise.resolve(response("Explain what a tmux window title is")),
			retry.promise,
		]);
		f.input("Explain in two short sentences what a tmux window title is.");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.requests[1].options.signal).toBe(f.requests[0].options.signal);
		expect(timers).toHaveLength(1);
		timers[0].fire();
		await settle();
		const signal = f.requests[1].options.signal as AbortSignal;
		expect(signal.aborted).toBe(true);
		expect(cleared.has(timers[0].handle)).toBe(true);
		expect(getEventListeners(signal, "abort")).toHaveLength(0);
		expect(f.state.title).toBe("existing task");
		expect(f.warnings).toHaveLength(1);
		retry.resolve(response("stale correction"));
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.warnings).toHaveLength(1);
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

test("rejects excess naming response blocks before inspecting them", async () => {
	const content = Array.from({ length: 129 }, () => ({ type: "text", text: "fix auth tests" }));
	Object.defineProperty(content, 0, { get: () => { throw new Error("response blocks should not be inspected"); } });
	const f = fixture([Promise.resolve({ ...response(""), content })]);
	f.input("Name a task");
	await settle();
	expect(f.requests).toHaveLength(1);
	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(f.warnings).toEqual(["The naming model returned too many content blocks; the current title was kept."]);
});

test.each(["one block", "combined final blocks"])("bounds oversized selected model output from %s before joining it", async (shape) => {
	const oversized = "x".repeat(64 * 1024 + 1);
	const first = shape === "one block"
		? response(oversized)
		: {
			...response(""),
			content: [
				{ type: "text", text: oversized.slice(0, 32 * 1024), textSignature: JSON.stringify({ v: 1, phase: "final_answer" }) },
				{ type: "text", text: oversized.slice(32 * 1024), textSignature: JSON.stringify({ v: 1, phase: "final_answer" }) },
			],
		};
	const f = fixture([Promise.resolve(first), Promise.resolve(response("fix auth tests"))]);
	f.input("Name a task");
	await settle();
	expect(f.requests).toHaveLength(2);
	expect(f.requests[1].context.systemPrompt).toContain("previous candidate exceeded a title limit");
	expect(f.requests[1].context.systemPrompt).not.toContain(oversized);
	expect(f.state.title).toBe("fix auth tests");
	expect(f.warnings).toEqual([]);
});

test("ignores oversized commentary when a bounded final answer is available", async () => {
	const result = {
		...response(""),
		content: [
			{ type: "text", text: "x".repeat(64 * 1024 + 1), textSignature: JSON.stringify({ v: 1, phase: "commentary" }) },
			{ type: "text", text: "fix auth tests", textSignature: JSON.stringify({ v: 1, phase: "final_answer" }) },
		],
	};
	const f = fixture([Promise.resolve(result)]);
	f.input("Name a task");
	await settle();
	expect(f.requests).toHaveLength(1);
	expect(f.state.title).toBe("fix auth tests");
	expect(f.warnings).toEqual([]);
});

test("treats an oversized phase signature as unrecognized metadata without parsing it", async () => {
	const textSignature = JSON.stringify({ v: 1, phase: "final_answer", extra: "x".repeat(4 * 1024) });
	const result = {
		...response(""),
		content: [{ type: "text", text: "fix auth tests", textSignature }],
	};
	const f = fixture([Promise.resolve(result)]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(f.warnings).toEqual(["The naming model did not return a final answer; the current title was kept."]);
});

test("a normal final answer remains selectable beside oversized unrecognized metadata", async () => {
	const textSignature = JSON.stringify({ v: 1, phase: "commentary", extra: "x".repeat(4 * 1024) });
	const result = {
		...response(""),
		content: [
			{ type: "text", text: "commentary not used", textSignature },
			{ type: "text", text: "fix auth tests", textSignature: JSON.stringify({ v: 1, phase: "final_answer" }) },
		],
	};
	const f = fixture([Promise.resolve(result)]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("fix auth tests");
	expect(f.warnings).toEqual([]);
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
	expect(f.warnings).toEqual(["The naming model did not return a final answer; the current title was kept."]);
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
	expect(f.warnings).toEqual(["The naming model did not return a final answer; the current title was kept."]);
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
	expect(f.warnings).toEqual(["The naming model did not return a final answer; the current title was kept."]);
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
	["Explain in two short sentences what a tmux window title is.", "tmux window titles"],
	["one two three four five", "tmux title basics"],
])("retries an overlong or over-word-count first title once: %s", async (firstOutput, correctedTitle) => {
	const f = fixture([
		Promise.resolve(response(firstOutput)),
		Promise.resolve(response(correctedTitle)),
	]);
	f.input("Explain in two short sentences what a tmux window title is. Do not use any tools.");
	await settle();
	expect(f.requests).toHaveLength(2);
	expect(f.requests[0].context.messages[0].content).toBe(f.requests[1].context.messages[0].content);
	expect(f.requests[1].context.systemPrompt).toContain("previous candidate exceeded a title limit");
	expect(f.requests[1].context.systemPrompt).toContain("Do not restate the full request");
	expect(f.requests[1].context.systemPrompt).toContain("answer-format constraints");
	expect(f.requests[1].context.systemPrompt).toContain(`${MAX_TITLE_LENGTH} ASCII characters`);
	expect(f.requests[1].context.systemPrompt).not.toContain(firstOutput);
	expect(f.requests[1].options.maxRetries).toBe(0);
	expect(f.state.title).toBe(correctedTitle);
	expect(f.warnings).toEqual([]);
});

test("clips a still-overlong retry at a word boundary when it remains title-shaped", async () => {
	const f = fixture([
		Promise.resolve(response("Explain in two short sentences what a tmux window title is")),
		Promise.resolve(response("tmux window title explanation")),
	]);
	f.input("Explain in two short sentences what a tmux window title is. Do not use any tools.");
	await settle();
	expect(f.requests).toHaveLength(2);
	expect(f.state.title).toBe("tmux window title");
	expect(f.state.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
	expect(f.state.title.split(" ")).toHaveLength(3);
	expect(f.warnings).toEqual([]);
});

test("superseding input cancels an overlong-title retry without applying its stale result", async () => {
	const retry = deferred();
	const f = fixture([
		Promise.resolve(response("Explain what a tmux window title is")),
		retry.promise,
		Promise.resolve(response("new task")),
	]);
	f.input("Old task");
	await settle();
	expect(f.requests).toHaveLength(2);
	const retrySignal = f.requests[1].options.signal as AbortSignal;
	f.input("New task");
	await settle();
	expect(retrySignal.aborted).toBe(true);
	retry.resolve(response("stale title"));
	await settle();
	expect(f.requests).toHaveLength(3);
	expect(f.state.title).toBe("new task");
	expect(f.warnings).toEqual([]);
});

test.each([
	["line feed", "\n"],
	["carriage return", "\r"],
	["vertical tab", "\v"],
	["form feed", "\f"],
	["next line", "\u0085"],
	["line separator", "\u2028"],
	["paragraph separator", "\u2029"],
])("rejects %s in naming output as a line break", async (_name, separator) => {
	const f = fixture([Promise.resolve(response(`fix auth${separator}tests`))]);
	f.input("Name a task");
	await settle();
	expect(f.requests).toHaveLength(1);
	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(f.warnings).toEqual(["The naming model returned multiple lines instead of one title; the current title was kept."]);
});

test.each([
	["line feed", "\n"],
	["carriage return", "\r"],
	["vertical tab", "\v"],
	["form feed", "\f"],
	["next line", "\u0085"],
	["line separator", "\u2028"],
	["paragraph separator", "\u2029"],
])("rejects %s at either edge of naming output", async (_name, separator) => {
	for (const output of [`${separator}fix auth tests`, `fix auth tests${separator}`]) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(1);
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["The naming model returned multiple lines instead of one title; the current title was kept."]);
	}
});

test("accepts ordinary surrounding spaces in naming output", async () => {
	const f = fixture([Promise.resolve(response("  fix auth tests  "))]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("fix auth tests");
	expect(f.warnings).toEqual([]);
});

test.each([
	["I'll inspect the conversation and choose a title.", "The naming model title exceeded the 24-character limit; the current title was kept.", true],
	["one two three four five", "The naming model title exceeded the 4-word limit; the current title was kept.", true],
	["fix ssh\nhelpers", "The naming model returned multiple lines instead of one title; the current title was kept.", false],
	["investigate authentication failures", "The naming model title exceeded the 24-character limit; the current title was kept.", true],
	["---", "The naming model returned no usable title; the current title was kept.", false],
])("rejects output that remains invalid after at most one retry: %s", async (output, warning, retry) => {
	const results = [Promise.resolve(response(output))];
	if (retry) results.push(Promise.resolve(response(output)));
	const f = fixture(results);
	f.input("Name a task");
	await settle();
	expect(f.requests).toHaveLength(retry ? 2 : 1);
	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(f.warnings).toEqual([warning]);
});

test("does not apply a short-looking response truncated by the token limit", async () => {
	const f = fixture([Promise.resolve(response("fix ssh", "length"))]);
	f.input("Name a task");
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(f.warnings).toEqual(["The naming model hit its token limit before finishing a title; the current title was kept."]);
});

test("sensitive-looking prompts and recent history never reach the naming model", async () => {
	const token = ["ghp_", "A".repeat(20)].join("");
	const warning = "Sensitive-looking task context was not sent to the naming model; the current title was kept.";
	const suppressed = async (f: ReturnType<typeof fixture>, prompt: string, sensitiveText = token) => {
		const find = spyOn(f.ctx.modelRegistry, "find");
		f.input(prompt);
		await settle();
		expect(find).not.toHaveBeenCalled();
		expect(f.requests).toHaveLength(0);
		expect(f.state.title).toBe("existing task");
		expect(f.warnings).toEqual([warning]);
		expect(f.warnings.join(" ")).not.toContain(sensitiveText);
	};

	await suppressed(fixture(), `Review the auth flow with ${token}`);
	const googleApiKey = `AIza${"A".repeat(35)}`;
	await suppressed(fixture(), `Review Google API access ${googleApiKey}`, googleApiKey);
	const googleOAuthAccessToken = `ya29.${"A".repeat(32)}`;
	await suppressed(fixture(), `Review Google OAuth access ${googleOAuthAccessToken}`, googleOAuthAccessToken);
	const obfuscatedGoogleOAuthAccessToken = `ya29.${"A".repeat(16)}\u200b${"B".repeat(16)}`;
	await suppressed(fixture(), `Review Google OAuth access ${obfuscatedGoogleOAuthAccessToken}`, obfuscatedGoogleOAuthAccessToken);
	const datadogApiKey = "A1b2".repeat(10);
	await suppressed(fixture(), `Review the config Datadog: ${datadogApiKey}`, datadogApiKey);
	const mailgunPrivateApiToken = `key-${"a1b2".repeat(8)}`;
	await suppressed(fixture(), `Review Mailgun API access: ${mailgunPrivateApiToken}`, mailgunPrivateApiToken);
	const artifactoryApiKey = `AKCp${"A1b2".repeat(17)}A`;
	const artifactoryReferenceToken = `cmVmd${"C1d2".repeat(14)}AbC`;
	await suppressed(fixture(), `Review the artifact repository ${artifactoryApiKey}`, artifactoryApiKey);
	await suppressed(fixture(), `Review the artifact repository ${artifactoryReferenceToken}`, artifactoryReferenceToken);
	const flyIoOrgToken = `fo1_${"A1_b".repeat(10)}ABC`;
	const flyIoMachineTokens = [
		`fm1a_${"A1b+/".repeat(20)}`,
		`fm1r_${"B2c+/".repeat(20)}=`,
		`fm2_${"C3d+/".repeat(20)}===`,
	];
	await suppressed(fixture(), `Review Fly.io access ${flyIoOrgToken}`, flyIoOrgToken);
	for (const flyIoMachineToken of flyIoMachineTokens) {
		await suppressed(fixture(), `Review Fly.io access ${flyIoMachineToken}`, flyIoMachineToken);
	}
	const dynatraceApiToken = `dt0c01.${"A1b2".repeat(6)}.${"C3d4".repeat(16)}`;
	await suppressed(fixture(), `Review Dynatrace access ${dynatraceApiToken}`, dynatraceApiToken);
	const resendApiKey = `re_${"A1b2".repeat(7)}_C3d4`;
	await suppressed(fixture(), `Review Resend access ${resendApiKey}`, resendApiKey);
	const supabaseSecretKey = `sb_secret_${"S".repeat(32)}`;
	await suppressed(fixture(), `Review the Supabase config ${supabaseSecretKey}`, supabaseSecretKey);
	const neonApiKey = `neon_api_key_${"N".repeat(32)}`;
	await suppressed(fixture(), `Review the Neon config ${neonApiKey}`, neonApiKey);
	const vaultServiceToken = `hvs.${"V".repeat(24)}`;
	const vaultBatchToken = `hvb.${"B".repeat(24)}`;
	await suppressed(fixture(), `Review Vault access ${vaultServiceToken}`, vaultServiceToken);
	const sentryUserToken = `sntryu_${"a".repeat(64)}`;
	await suppressed(fixture(), `Review Sentry access ${sentryUserToken}`, sentryUserToken);
	const sentryOrgToken = `sntrys_eyJpYXQiO${"a".repeat(20)}LCJyZWdpb25fdXJs${"b".repeat(20)}_${"C".repeat(43)}`;
	await suppressed(fixture(), `Review Sentry organization access ${sentryOrgToken}`, sentryOrgToken);
	const telegramBotToken = `123456789:A${"a".repeat(34)}`;
	await suppressed(fixture(), `Test the handler with generated identifier ${telegramBotToken}`, telegramBotToken);
	const brevoApiToken = `xkeysib-${"a".repeat(64)}-${"B".repeat(16)}`;
	await suppressed(fixture(), `Review the mail integration with ${brevoApiToken}`, brevoApiToken);
	const atlassianApiToken = "ATATT3" + "a".repeat(183) + "_-=";
	await suppressed(fixture(), `Review the integration with ${atlassianApiToken}`, atlassianApiToken);
	const terraformCloudToken = `${"T".repeat(14)}.atlasv1.${"a".repeat(57)}_-=`;
	await suppressed(fixture(), `Review Terraform access ${terraformCloudToken}`, terraformCloudToken);
	const shopifyTokens = ["shpat_", "shpca_", "shppa_", "shpss_"].map((prefix) => `${prefix}${"a".repeat(32)}`);
	for (const token of shopifyTokens) {
		await suppressed(fixture(), `Review Shopify access ${token}`, token);
	}
	const shippoTokens = ["live", "test"].map((mode) => `shippo_${mode}_${"a".repeat(40)}`);
	for (const token of shippoTokens) {
		await suppressed(fixture(), `Review Shippo access ${token}`, token);
	}
	const planetscaleTokens = ["tkn", "oauth"].flatMap((kind) => [
		`pscale_${kind}_${"A1_bc.-=".repeat(4)}`,
		`pscale_${kind}_${"B".repeat(64)}`,
	]);
	for (const token of planetscaleTokens) {
		await suppressed(fixture(), `Review PlanetScale access ${token}`, token);
	}
	const postmanToken = ["PMAK-", "a".repeat(24), "-", "b".repeat(34)].join("");
	await suppressed(fixture(), `Review Postman access ${postmanToken}`, postmanToken);
	const pulumiToken = `pul-${"a".repeat(40)}`;
	await suppressed(fixture(), `Review Pulumi access ${pulumiToken}`, pulumiToken);
	const prefectToken = `pnu_${"A1b2".repeat(9)}`;
	await suppressed(fixture(), `Review Prefect access ${prefectToken}`, prefectToken);
	const octopusApiKey = `API-${"A1B2".repeat(6)}A1`;
	await suppressed(fixture(), `Review Octopus access ${octopusApiKey}`, octopusApiKey);
	const sourcegraphToken = `sgp_${"a".repeat(40)}`;
	const sourcegraphSegmentedToken = `sgp_${"b".repeat(16)}_${"c".repeat(40)}`;
	const sourcegraphLocalToken = `sgp_local_${"d".repeat(40)}`;
	await suppressed(fixture(), `Review Sourcegraph access ${sourcegraphToken}`, sourcegraphToken);
	await suppressed(fixture(), `Review Sourcegraph access ${sourcegraphSegmentedToken}`, sourcegraphSegmentedToken);
	await suppressed(fixture(), `Review Sourcegraph access ${sourcegraphLocalToken}`, sourcegraphLocalToken);
	const labeledCredential = `client_secret=${"C".repeat(24)}`;
	await suppressed(fixture(), `Build the OAuth flow with ${labeledCredential}`, labeledCredential);
	const shortPassword = `password=${"S".repeat(12)}`;
	await suppressed(fixture(), `Review the configuration ${shortPassword}`, shortPassword);
	const quotedPasswordPhrase = `password: "secret phrase"`;
	const inlinePasswordPhrase = `password=secret phrase`;
	const plainPassphrase = `passphrase: silver owl`;
	const foldedPlainPassword = `password: secret\n  phrase`;
	const punctuatedPassword = `password=secret phrase, keep this private`;
	const punctuatedColonPassword = `password=secret phrase: keep this private`;
	const punctuatedPassphrase = `passphrase: silver owl; do not copy it`;
	const punctuatedFoldedPassword = `password: secret\n  phrase, keep this private`;
	await suppressed(fixture(), `Review the configuration ${quotedPasswordPhrase}`, quotedPasswordPhrase);
	await suppressed(fixture(), `Review the configuration ${inlinePasswordPhrase}`, inlinePasswordPhrase);
	await suppressed(fixture(), `Review the configuration ${plainPassphrase}`, plainPassphrase);
	await suppressed(fixture(), `Review the configuration ${foldedPlainPassword}`, foldedPlainPassword);
	await suppressed(fixture(), `Review the configuration ${punctuatedPassword}`, punctuatedPassword);
	await suppressed(fixture(), `Review the configuration ${punctuatedColonPassword}`, punctuatedColonPassword);
	await suppressed(fixture(), `Review the configuration ${punctuatedPassphrase}`, punctuatedPassphrase);
	await suppressed(fixture(), `Review the configuration ${punctuatedFoldedPassword}`, punctuatedFoldedPassword);
	const passwordBlock = `password: |-\n  ${"P".repeat(12)}`;
	await suppressed(fixture(), `Review the configuration ${passwordBlock}`, passwordBlock);
	const multiwordPasswordBlock = `password: |-\n  secret phrase`;
	const foldedPassphraseBlock = `passphrase: &words >-\n  moonlight\n  meadow`;
	await suppressed(fixture(), `Review the configuration ${multiwordPasswordBlock}`, multiwordPasswordBlock);
	await suppressed(fixture(), `Review the configuration ${foldedPassphraseBlock}`, foldedPassphraseBlock);
	const taggedPasswordBlock = `password: !!str |-\n  ${"P".repeat(12)}`;
	const anchoredTokenBlock = `token: &task-token >-\n  ${"T".repeat(24)}`;
	await suppressed(fixture(), `Review the configuration ${taggedPasswordBlock}`, taggedPasswordBlock);
	await suppressed(fixture(), `Review the configuration ${anchoredTokenBlock}`, anchoredTokenBlock);
	const placeholderThenSecretBlocks = [
		"password: |-\n  example",
		`token: >-\n  ${"T".repeat(24)}`,
	].join("\n");
	await suppressed(
		fixture(), `Review the configuration ${placeholderThenSecretBlocks}`, placeholderThenSecretBlocks,
	);
	const awsSecretAccessKey = `AWS_SECRET_ACCESS_KEY=${"A".repeat(40)}`;
	await suppressed(fixture(), `Review the deployment config ${awsSecretAccessKey}`, awsSecretAccessKey);
	const awsBlockSecretAccessKey = `AWS_SECRET_ACCESS_KEY: |-\n  ${"A".repeat(22)}\n  ${"B".repeat(22)}`;
	await suppressed(fixture(), `Review the deployment config ${awsBlockSecretAccessKey}`, awsBlockSecretAccessKey);
	const azureAccountKey = `AccountKey=${"A".repeat(86)}==`;
	await suppressed(fixture(), `Review the storage connection ${azureAccountKey}`, azureAccountKey);
	const kubeconfigClientKeyData = `client-key-data: ${"A".repeat(44)}`;
	await suppressed(
		fixture(), `Review the Kubernetes config ${kubeconfigClientKeyData}`, kubeconfigClientKeyData,
	);
	const kubeconfigBlockClientKeyData = `client-key-data: |-\n  ${"A".repeat(10)}\n  ${"A".repeat(10)}\n  ${"A".repeat(44)}`;
	await suppressed(
		fixture(), `Review the Kubernetes config ${kubeconfigBlockClientKeyData}`, kubeconfigBlockClientKeyData,
	);
	const wireGuardPresharedKey = `PresharedKey=${"A".repeat(43)}=`;
	await suppressed(
		fixture(), `Review the WireGuard configuration ${wireGuardPresharedKey}`, wireGuardPresharedKey,
	);
	const basicAuthorization = basicAuthorizationHeader("Authorization", `u:${"p".repeat(20)}`);
	const proxyBasicAuthorization = basicAuthorizationHeader("Proxy-Authorization", `p:${"w".repeat(20)}`);
	const shortBasicAuthorization = basicAuthorizationHeader("Authorization", "u:p");
	const shortProxyAuthorization = basicAuthorizationHeader("Proxy-Authorization", "p:w");
	const basicAuthorizationBlock = `Authorization: |-\n  Basic ${Buffer.from("u:p").toString("base64")}`;
	const taggedBasicAuthorizationBlock = `Authorization: !!str |-\n  Basic ${Buffer.from("u:p").toString("base64")}`;
	const proxyBasicAuthorizationBlock = `Proxy-Authorization: >-\n  Basic\n  ${Buffer.from("p:w").toString("base64")}`;
	const anchoredProxyBasicAuthorizationBlock = `Proxy-Authorization: &proxy-auth >-\n  Basic\n  ${Buffer.from("p:w").toString("base64")}`;
	const placeholderThenBasicBlocks = [
		"Authorization: |-\n  Basic example",
		proxyBasicAuthorizationBlock,
	].join("\n");
	await suppressed(fixture(), `Review the request headers ${basicAuthorization}`, basicAuthorization);
	await suppressed(fixture(), `Review the proxy headers ${proxyBasicAuthorization}`, proxyBasicAuthorization);
	await suppressed(fixture(), `Review the short request headers ${shortBasicAuthorization}`, shortBasicAuthorization);
	await suppressed(fixture(), `Review the short proxy headers ${shortProxyAuthorization}`, shortProxyAuthorization);
	await suppressed(fixture(), `Review the request headers ${basicAuthorizationBlock}`, basicAuthorizationBlock);
	await suppressed(fixture(), `Review the request headers ${taggedBasicAuthorizationBlock}`, taggedBasicAuthorizationBlock);
	await suppressed(fixture(), `Review the proxy headers ${proxyBasicAuthorizationBlock}`, proxyBasicAuthorizationBlock);
	await suppressed(
		fixture(), `Review the proxy headers ${anchoredProxyBasicAuthorizationBlock}`, anchoredProxyBasicAuthorizationBlock,
	);
	await suppressed(fixture(), `Review the auth headers ${placeholderThenBasicBlocks}`, placeholderThenBasicBlocks);
	const obfuscatedPassword = `passphrase=${"P".repeat(5)}\u200b${"P".repeat(5)}`;
	await suppressed(fixture(), `Review the configuration ${obfuscatedPassword}`, obfuscatedPassword);

	const emailAddress = "customer@example.test";
	await suppressed(fixture(), `Update the notification flow for ${emailAddress}`, emailAddress);
	const obfuscatedEmailAddress = "customer@\u200bexample.test";
	await suppressed(fixture(), `Update the notification flow for ${obfuscatedEmailAddress}`, obfuscatedEmailAddress);

	const labeledSsn = "ssn=000-00-0000";
	await suppressed(fixture(), `Validate the imported record ${labeledSsn}`, labeledSsn);
	const labeledPhone = "phone=0000000";
	await suppressed(fixture(), `Validate the imported record ${labeledPhone}`, labeledPhone);
	const labeledCard = "card number=0000000000000000";
	await suppressed(fixture(), `Validate the imported record ${labeledCard}`, labeledCard);

	const databaseUrl = "postgres://test-user:example-only-password@db.example.test/app";
	await suppressed(fixture(), `Review the database connection ${databaseUrl}`, databaseUrl);
	const obfuscatedUrl = "postgres://test-user:example-only-\u200bpassword@db.example.test/app";
	await suppressed(fixture(), `Review the database connection ${obfuscatedUrl}`, obfuscatedUrl);
	const azureSasUrl = `https://storage.example.test/blob?sv=2023-11-03&ss=b&srt=o&sp=r&se=2030-01-01T00%3A00%3A00Z&sig=${"A".repeat(43)}=`;
	await suppressed(fixture(), `Review the storage download ${azureSasUrl}`, azureSasUrl);
	const reversedAzureSasUrl = `https://storage.example.test/blob?sig=${"A".repeat(43)}=&sv=2023-11-03&sp=r`;
	await suppressed(fixture(), `Review the storage download ${reversedAzureSasUrl}`, reversedAzureSasUrl);

	const versionWithoutSignature = fixture([Promise.resolve(response("review storage"))]);
	versionWithoutSignature.input("Review https://storage.example.test/blob?sv=2023-11-03&ss=b&srt=o&sp=r");
	await settle();
	expect(versionWithoutSignature.requests).toHaveLength(1);
	expect(versionWithoutSignature.warnings).toEqual([]);
	const shortSasSignature = fixture([Promise.resolve(response("review storage"))]);
	shortSasSignature.input("Review https://storage.example.test/blob?sv=2023-11-03&sig=short-signature");
	await settle();
	expect(shortSasSignature.requests).toHaveLength(1);
	expect(shortSasSignature.warnings).toEqual([]);

	const history = fixture();
	history.messages.push({ role: "assistant", content: [{ type: "text", text: `The test fixture includes ${token}` }] });
	await suppressed(history, "Continue the task");
	const historyWithGoogleApiKey = fixture();
	historyWithGoogleApiKey.messages.push({ role: "assistant", content: [{ type: "text", text: `Google API key: ${googleApiKey}` }] });
	await suppressed(historyWithGoogleApiKey, "Continue the task", googleApiKey);
	const historyWithDatadogApiKey = fixture();
	historyWithDatadogApiKey.messages.push({ role: "assistant", content: [{ type: "text", text: `Datadog: ${datadogApiKey}` }] });
	await suppressed(historyWithDatadogApiKey, "Continue the task", datadogApiKey);
	const historyWithMailgunToken = fixture();
	historyWithMailgunToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Mailgun API key: ${mailgunPrivateApiToken}` }] });
	await suppressed(historyWithMailgunToken, "Continue the task", mailgunPrivateApiToken);
	const historyWithArtifactoryApiKey = fixture();
	historyWithArtifactoryApiKey.messages.push({ role: "assistant", content: [{ type: "text", text: artifactoryApiKey }] });
	await suppressed(historyWithArtifactoryApiKey, "Continue the task", artifactoryApiKey);
	const historyWithArtifactoryReferenceToken = fixture();
	historyWithArtifactoryReferenceToken.messages.push({ role: "assistant", content: [{ type: "text", text: artifactoryReferenceToken }] });
	await suppressed(historyWithArtifactoryReferenceToken, "Continue the task", artifactoryReferenceToken);
	const historyWithFlyIoOrgToken = fixture();
	historyWithFlyIoOrgToken.messages.push({ role: "assistant", content: [{ type: "text", text: flyIoOrgToken }] });
	await suppressed(historyWithFlyIoOrgToken, "Continue the task", flyIoOrgToken);
	for (const flyIoMachineToken of flyIoMachineTokens) {
		const historyWithFlyIoMachineToken = fixture();
		historyWithFlyIoMachineToken.messages.push({ role: "assistant", content: [{ type: "text", text: flyIoMachineToken }] });
		await suppressed(historyWithFlyIoMachineToken, "Continue the task", flyIoMachineToken);
	}
	const historyWithDynatraceToken = fixture();
	historyWithDynatraceToken.messages.push({ role: "assistant", content: [{ type: "text", text: dynatraceApiToken }] });
	await suppressed(historyWithDynatraceToken, "Continue the task", dynatraceApiToken);
	const historyWithResendApiKey = fixture();
	historyWithResendApiKey.messages.push({ role: "assistant", content: [{ type: "text", text: resendApiKey }] });
	await suppressed(historyWithResendApiKey, "Continue the task", resendApiKey);
	const historyWithSupabaseSecret = fixture();
	historyWithSupabaseSecret.messages.push({ role: "assistant", content: [{ type: "text", text: `Supabase key: ${supabaseSecretKey}` }] });
	await suppressed(historyWithSupabaseSecret, "Continue the task", supabaseSecretKey);
	const historyWithNeonKey = fixture();
	historyWithNeonKey.messages.push({ role: "assistant", content: [{ type: "text", text: `Neon key: ${neonApiKey}` }] });
	await suppressed(historyWithNeonKey, "Continue the task", neonApiKey);
	const historyWithVaultToken = fixture();
	historyWithVaultToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Vault token: ${vaultBatchToken}` }] });
	await suppressed(historyWithVaultToken, "Continue the task", vaultBatchToken);
	const historyWithSentryToken = fixture();
	historyWithSentryToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Sentry token: ${sentryUserToken}` }] });
	await suppressed(historyWithSentryToken, "Continue the task", sentryUserToken);
	const historyWithSentryOrgToken = fixture();
	historyWithSentryOrgToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Sentry organization token: ${sentryOrgToken}` }] });
	await suppressed(historyWithSentryOrgToken, "Continue the task", sentryOrgToken);
	const historyWithTelegramToken = fixture();
	historyWithTelegramToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Generated identifier: ${telegramBotToken}` }] });
	await suppressed(historyWithTelegramToken, "Continue the task", telegramBotToken);
	const historyWithBrevoToken = fixture();
	historyWithBrevoToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Mail integration key: ${brevoApiToken}` }] });
	await suppressed(historyWithBrevoToken, "Continue the task", brevoApiToken);
	const historyWithAtlassianToken = fixture();
	historyWithAtlassianToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Generated value: ${atlassianApiToken}` }] });
	await suppressed(historyWithAtlassianToken, "Continue the task", atlassianApiToken);
	const historyWithTerraformToken = fixture();
	historyWithTerraformToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Generated value: ${terraformCloudToken}` }] });
	await suppressed(historyWithTerraformToken, "Continue the task", terraformCloudToken);
	const historyWithShopifyToken = fixture();
	historyWithShopifyToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Generated value: ${shopifyTokens[1]!}` }] });
	await suppressed(historyWithShopifyToken, "Continue the task", shopifyTokens[1]!);
	const historyWithShippoToken = fixture();
	historyWithShippoToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Generated value: ${shippoTokens[0]!}` }] });
	await suppressed(historyWithShippoToken, "Continue the task", shippoTokens[0]!);
	const historyWithPlanetScaleToken = fixture();
	historyWithPlanetScaleToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Generated value: ${planetscaleTokens[2]!}` }] });
	await suppressed(historyWithPlanetScaleToken, "Continue the task", planetscaleTokens[2]!);
	const historyWithPostmanToken = fixture();
	historyWithPostmanToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Generated value: ${postmanToken}` }] });
	await suppressed(historyWithPostmanToken, "Continue the task", postmanToken);
	const historyWithPulumiToken = fixture();
	historyWithPulumiToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Generated value: ${pulumiToken}` }] });
	await suppressed(historyWithPulumiToken, "Continue the task", pulumiToken);
	const historyWithPrefectToken = fixture();
	historyWithPrefectToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Generated value: ${prefectToken}` }] });
	await suppressed(historyWithPrefectToken, "Continue the task", prefectToken);
	const historyWithOctopusApiKey = fixture();
	historyWithOctopusApiKey.messages.push({ role: "assistant", content: [{ type: "text", text: `Generated value: ${octopusApiKey}` }] });
	await suppressed(historyWithOctopusApiKey, "Continue the task", octopusApiKey);
	const historyWithSourcegraphToken = fixture();
	historyWithSourcegraphToken.messages.push({ role: "assistant", content: [{ type: "text", text: `Generated value: ${sourcegraphSegmentedToken}` }] });
	await suppressed(historyWithSourcegraphToken, "Continue the task", sourcegraphSegmentedToken);
	const historyWithEmail = fixture();
	historyWithEmail.messages.push({ role: "assistant", content: [{ type: "text", text: `Previous contact: ${emailAddress}` }] });
	await suppressed(historyWithEmail, "Continue the task", emailAddress);
	const historyWithSsn = fixture();
	historyWithSsn.messages.push({ role: "assistant", content: [{ type: "text", text: `Previous record: ${labeledSsn}` }] });
	await suppressed(historyWithSsn, "Continue the task", labeledSsn);

	const obfuscated = `ghp_${"A".repeat(10)}\u200b${"A".repeat(10)}`;
	await suppressed(fixture(), `Review ${obfuscated}`);

	const compatibilityToken = [...token]
		.map((character) => String.fromCodePoint(character.charCodeAt(0) + 0xfee0)).join("");
	await suppressed(fixture(), `Review ${compatibilityToken}`);

	const nearMiss = fixture([Promise.resolve(response("fix auth tests"))]);
	nearMiss.input(`Review ghp_${"A".repeat(19)}`);
	await settle();
	expect(nearMiss.requests).toHaveLength(1);
	expect(nearMiss.state.title).toBe("fix auth tests");
	expect(nearMiss.warnings).toEqual([]);

	const uriWithoutPassword = fixture([Promise.resolve(response("review database"))]);
	uriWithoutPassword.input("Review postgres://test-user@localhost/app");
	await settle();
	expect(uriWithoutPassword.requests).toHaveLength(1);
	expect(uriWithoutPassword.state.title).toBe("review database");
	expect(uriWithoutPassword.warnings).toEqual([]);

	const unlabeledNumbers = fixture([Promise.resolve(response("review record"))]);
	unlabeledNumbers.input("Review record 000-00-0000 and 0000000");
	await settle();
	expect(unlabeledNumbers.requests).toHaveLength(1);
	expect(unlabeledNumbers.state.title).toBe("review record");
	expect(unlabeledNumbers.warnings).toEqual([]);

	const placeholderCredentials = fixture([Promise.resolve(response("review docs"))]);
	placeholderCredentials.input([
		"Review docs with password=placeholder, passphrase=example, token: placeholder,",
		"AWS_SECRET_ACCESS_KEY=example, AccountKey=example, PresharedKey=example,",
		"client-key-data: example, Authorization: Basic example,",
		`password: "example value", passphrase: example value, password: example\n  value`,
		"password=example phrase, continue; password=example phrase: continue; passphrase: placeholder phrase; continue",
		"\nAuthorization: |-\n  Basic example\n",
		"\nAuthorization: !!str |-\n  Basic example\n",
		"\nProxy-Authorization: >-\n  Basic example\n",
		"\nProxy-Authorization: &proxy-auth >-\n  Basic example\n",
		"\nclient-key-data: |-\n  example\n",
		"\npassword: |-\n  example\n",
		"\npassword: |-\n  example value\n",
		"\npassphrase: &phrase >-\n  your password\n",
		"\ntoken: |-\n  example\n",
		`Authorization: Basic ${"A".repeat(20)}`,
	].join(" "));
	await settle();
	expect(placeholderCredentials.requests).toHaveLength(1);
	expect(placeholderCredentials.state.title).toBe("review docs");
	expect(placeholderCredentials.warnings).toEqual([]);
});

test("safe naming can resume after a credential-looking context is blocked", async () => {
	const token = ["ghp_", "C".repeat(20)].join("");
	const f = fixture([Promise.resolve(response("fix auth tests"))]);
	const find = spyOn(f.ctx.modelRegistry, "find");
	f.input(`Review ${token}`);
	await settle();
	expect(find).not.toHaveBeenCalled();
	expect(f.requests).toHaveLength(0);
	expect(f.state.title).toBe("existing task");

	f.input("Fix auth tests");
	await settle();
	expect(f.requests).toHaveLength(1);
	expect(f.state.title).toBe("fix auth tests");
	expect(f.warnings).toEqual(["Sensitive-looking task context was not sent to the naming model; the current title was kept."]);
	expect(f.warnings.join(" ")).not.toContain(token);
});

test("new credential-looking context cancels in-flight naming without sending it", async () => {
	const result = deferred();
	const f = fixture([result.promise]);
	f.input("Fix auth tests");
	await settle();
	expect(f.requests).toHaveLength(1);
	const previousSignal = f.requests[0].options.signal as AbortSignal;
	const find = spyOn(f.ctx.modelRegistry, "find");
	const token = ["ghp_", "B".repeat(20)].join("");
	f.input(`Use ${token} to test the integration`);
	await settle();
	expect(previousSignal.aborted).toBe(true);
	expect(find).not.toHaveBeenCalled();
	expect(f.requests).toHaveLength(1);
	expect(f.state.title).toBe("existing task");
	expect(f.warnings).toEqual(["Sensitive-looking task context was not sent to the naming model; the current title was kept."]);
	expect(f.warnings.join(" ")).not.toContain(token);
	result.resolve(response("fix auth tests"));
	await settle();
	expect(f.state.title).toBe("existing task");
});

test("credential-shaped model output is rejected without applying or disclosing it", async () => {
	const githubToken = ["ghp_", "a".repeat(20)].join("");
	const googleApiKey = `AIza${"A".repeat(35)}`;
	const datadogApiKey = "A1b2".repeat(10);
	const dynatraceApiToken = `dt0c01.${"A1b2".repeat(6)}.${"C3d4".repeat(16)}`;
	const resendApiKey = `re_${"A1b2".repeat(7)}_C3d4`;
	const replicateToken = ["r8_", "M".repeat(37)].join("");
	const awsKey = ["AKIA", "A".repeat(16)].join("");
	const azureSasUrl = `https://storage.example.test/blob?sv=2023-11-03&ss=b&srt=o&sp=r&se=2030-01-01T00%3A00%3A00Z&sig=${"A".repeat(43)}=`;
	const compatibilityGithubToken = [...githubToken]
		.map((character) => String.fromCodePoint(character.charCodeAt(0) + 0xfee0)).join("");
	const basicAuthHeaders = [
		basicAuthorizationHeader("Authorization", `u:${"p".repeat(20)}`),
		basicAuthorizationHeader("Proxy-Authorization", `p:${"w".repeat(20)}`),
		basicAuthorizationHeader("Authorization", "u:p"),
		basicAuthorizationHeader("Proxy-Authorization", "p:w"),
	];
	const outputs = [
		`password=${"S".repeat(12)}`,
		`password=secret phrase`,
		`password: "secret phrase"`,
		`passphrase: silver owl`,
		`password: secret\n  phrase`,
		`password=secret phrase, keep this private`,
		`password=secret phrase: keep this private`,
		`passphrase: silver owl; do not copy it`,
		`password: secret\n  phrase, keep this private`,
		`password: |-\n  ${"P".repeat(12)}`,
		`password: |-\n  secret phrase`,
		`passphrase: &words >-\n  moonlight\n  meadow`,
		`password: !!str |-\n  ${"P".repeat(12)}`,
		`token: &task-token >-\n  ${"T".repeat(24)}`,
		`Authorization: |-\n  Basic ${Buffer.from("u:p").toString("base64")}`,
		`Authorization: !!str |-\n  Basic ${Buffer.from("u:p").toString("base64")}`,
		`Proxy-Authorization: >-\n  Basic ${Buffer.from("p:w").toString("base64")}`,
		`Proxy-Authorization: &proxy-auth >-\n  Basic ${Buffer.from("p:w").toString("base64")}`,
		[
			"password: |-\n  example",
			`token: >-\n  ${"T".repeat(24)}`,
		].join("\n"),
		`AWS_SECRET_ACCESS_KEY=${"A".repeat(40)}`,
		`AWS_SECRET_ACCESS_KEY: |-\n  ${"A".repeat(22)}\n  ${"B".repeat(22)}`,
		`AccountKey=${"A".repeat(86)}==`,
		`client-key-data: ${"A".repeat(44)}`,
		`client-key-data: |2-\n  ${"A".repeat(10)}\n  ${"A".repeat(10)}\n  ${"A".repeat(44)}`,
		`PresharedKey=${"A".repeat(43)}=`,
		...basicAuthHeaders,
		azureSasUrl,
		"postgres://test-user:example-only-password@db.example.test/app",
		["gh", "p_", "a".repeat(36)].join(""),
		["gsk_", "a".repeat(24)].join(""),
		["fw_", "A".repeat(40)].join(""),
		`fixfw-${"B".repeat(40)}`,
		["fw", "_", "\u200b", "C".repeat(40)].join(""),
		["fpk_", "D".repeat(40)].join(""),
		["nvapi-", "I".repeat(40)].join(""),
		`fixnvapi-${"J".repeat(40)}`,
		replicateToken,
		`fix${replicateToken}`,
		["r8_", "N".repeat(18), "\u200b", "N".repeat(19)].join(""),
		["R8_", "O".repeat(37)].join(""),
		["SSN: ", "000", "-", "00", "-", "0000"].join(""),
		["Social Security Number=", "000000000"].join(""),
		["SSN: 00", "\u200b", "0-00-00", "\u200b", "00"].join(""),
		["MY_SERVICE_API_KEY=", "S".repeat(24)].join(""),
		["Access Token : ", "T".repeat(24)].join(""),
		["client_secret\": \"", "U".repeat(24), "\""].join(""),
		["private", "\u200b", "_key=", "V".repeat(24)].join(""),
		["refresh-token = ", "W".repeat(24)].join(""),
		["nvapi-", "K".repeat(19), "\u200b", "K".repeat(21)].join(""),
		["NVAPI-", "L".repeat(40)].join(""),
		["csk_", "E".repeat(48)].join(""),
		["csk-", "F".repeat(48)].join(""),
		["CSK_", "G".repeat(48)].join(""),
		["csk_", "G".repeat(23), "\u200b", "G".repeat(25)].join(""),
		`fixgsk_${"a".repeat(24)}`,
		["gsk", " ", "_", "a".repeat(24)].join(""),
		["xai-", "a".repeat(20)].join(""),
		`fixxai-${"a".repeat(20)}`,
		["xai", " ", "-", "a".repeat(20)].join(""),
		["pplx-", "a".repeat(48)].join(""),
		`fixpplx-${"a".repeat(48)}`,
		["pplx-", "a".repeat(24), "\u200b", "a".repeat(24)].join(""),
		`x${awsKey}`,
		`${awsKey}_x`,
		githubToken.toUpperCase(),
		compatibilityGithubToken,
		["github", "_pat_", "a".repeat(30)].join(""),
		["AKIA", "A".repeat(16)].join(""),
		["ASIA", "A".repeat(16)].join(""),
		["ABSK", "A".repeat(109)].join(""),
		["bedrock-api-key-", Buffer.from("bedrock.amazonaws.com").toString("base64")].join(""),
		["ABSK", "A".repeat(54), "\u200b", "A".repeat(55)].join(""),
		googleApiKey,
		`${googleApiKey.slice(0, 20)}\u200b${googleApiKey.slice(20)}`,
		`Datadog: ${datadogApiKey}`,
		`Datadog: ${datadogApiKey.slice(0, 20)}\u200b${datadogApiKey.slice(20)}`,
		dynatraceApiToken,
		`${dynatraceApiToken.slice(0, 20)}\u200b${dynatraceApiToken.slice(20)}`,
		resendApiKey,
		`${resendApiKey.slice(0, 12)}\u200b${resendApiKey.slice(12)}`,
		["sk", "-proj-", "a".repeat(32)].join(""),
		["sk", "-ant-", "a".repeat(32)].join(""),
		["sk", "-svcacct-", "a".repeat(32)].join(""),
		["sk", "-or-v1-", "a".repeat(32)].join(""),
		`fixsk-or-v1-${"a".repeat(32)}`,
		["sk-or", " ", "-v1-", "a".repeat(32)].join(""),
		["sk", "_live_", "a".repeat(24)].join(""),
		`fixsk-${"a".repeat(16)}`,
		`fixrk-${"a".repeat(16)}`,
		["xoxb-", "a".repeat(24)].join(""),
		["xoxc-", "a".repeat(24)].join(""),
		["xoxd-", "a".repeat(24)].join(""),
		["npm_", "a".repeat(24)].join(""),
		["glpat-", "a".repeat(24)].join(""),
		["hf_", "a".repeat(32)].join(""),
		`hf_${"a".repeat(19)} a`,
		`hf_${"a".repeat(10)}\u200b${"a".repeat(10)}`,
		`hf_${"a".repeat(10)}\u0000${"a".repeat(10)}`,
		["eyJ", "a".repeat(8), ".", "b".repeat(8), ".", "c".repeat(8)].join(""),
		["Bearer ", "a".repeat(24)].join(""),
		["Bearer ", "a".repeat(8), " ", "a".repeat(8)].join(""),
		["Bearer ", "a".repeat(7), "1 ", "a".repeat(8)].join(""),
		["-----BEGIN ", "PRIVATE KEY-----"].join(""),
		["-----BEGIN ", "DSA PRIVATE KEY-----"].join(""),
		["-----BEGIN ", "ENCRYPTED PRIVATE KEY-----"].join(""),
		["-----BEGIN PGP ", "PRIVATE KEY BLOCK-----"].join(""),
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

test("rejects labeled Datadog API keys without mistaking near-misses for keys", async () => {
	const keyValue = "A1b2".repeat(10);
	const outputs = [
		`Datadog: ${keyValue}`,
		`DATADOG_API_KEY=${keyValue}`,
		`Datadog: ${keyValue.slice(0, 20)}\u200b${keyValue.slice(20)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(keyValue);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("datadog tests"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("datadog tests");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		`Datadog: ${"A1b2".repeat(9)}A1b`,
		`Datadog: ${keyValue}A`,
		`Datadog: ${keyValue}_`,
		`Datadog: ${keyValue}-`,
		`datadog ${keyValue}`,
		keyValue,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("datadog tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("datadog tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects labeled Mailgun private API tokens without mistaking near-misses for tokens", async () => {
	const token = `key-${"a1b2".repeat(8)}`;
	const sensitiveOutputs = [
		`Mailgun: ${token}`,
		`MAILGUN_API_KEY=${token}`,
		`mailgun: KEY-${"A1B2".repeat(8)}`,
		`Mailgun: ${token.slice(0, 20)}\u200b${token.slice(20)}`,
	];
	for (const output of sensitiveOutputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("mailgun tests"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("mailgun tests");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		`Mailgun: key-${"a1b2".repeat(7)}a1b`,
		`Mailgun: ${token}a`,
		`Mailgun: ${token}_`,
		`Mailgun: ${token}-`,
		`Mailgun ${token}`,
		token,
		`Mailgun: key-${"g".repeat(32)}`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("mailgun tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("mailgun tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Artifactory tokens without mistaking near-misses for tokens", async () => {
	const apiKey = `AKCp${"A1b2".repeat(17)}A`;
	const referenceToken = `cmVmd${"C1d2".repeat(14)}AbC`;
	const sensitiveOutputs = [
		apiKey,
		referenceToken,
		`${apiKey.slice(0, 24)}\u200b${apiKey.slice(24)}`,
		`${referenceToken.slice(0, 30)}\u200b${referenceToken.slice(30)}`,
	];
	for (const output of sensitiveOutputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(apiKey);
		expect(f.warnings.join(" ")).not.toContain(referenceToken);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("artifactory tests"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("artifactory tests");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		`AKCp${"A1b2".repeat(17)}`,
		`${apiKey}A`,
		`x${apiKey}`,
		`_${apiKey}`,
		`${apiKey}_`,
		`cmVmd${"C1d2".repeat(14)}Ab`,
		`${referenceToken}A`,
		`x${referenceToken}`,
		`${referenceToken}_`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("artifactory tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("artifactory tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Dynatrace API tokens without mistaking near-misses for tokens", async () => {
	const token = `dt0c01.${"A1b2".repeat(6)}.${"C3d4".repeat(16)}`;
	const sensitiveOutputs = [token, `Dynatrace API token: ${token}`, `${token.slice(0, 34)}\u200b${token.slice(34)}`];
	for (const output of sensitiveOutputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("dynatrace tests"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("dynatrace tests");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		`dt0c02.${"A1b2".repeat(6)}.${"C3d4".repeat(16)}`,
		`dt0c01.${"A1b2".repeat(6).slice(1)}.${"C3d4".repeat(16)}`,
		`dt0c01.${"A1b2".repeat(6)}A.${"C3d4".repeat(16)}`,
		`dt0c01.${"A1b2".repeat(6)}.${"C3d4".repeat(16).slice(1)}`,
		`dt0c01.${"A1b2".repeat(6)}.${"C3d4".repeat(16)}A`,
		`x${token}`,
		`_${token}`,
		`${token}A`,
		`${token}_`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("dynatrace tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("dynatrace tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Resend API keys without mistaking near-misses for keys", async () => {
	const apiKey = `re_${"A1b2".repeat(7)}_C3d4`;
	const sensitiveOutputs = [
		apiKey,
		`RESEND_API_KEY=${apiKey}`,
		`${apiKey}.`,
		`${apiKey}A`,
		`${apiKey.slice(0, 15)}\u200b${apiKey.slice(15)}`,
	];
	for (const output of sensitiveOutputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(apiKey);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("resend tests"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("resend tests");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		`re_${"A1b2".repeat(7)}_C3`,
		`rx_${"A1b2".repeat(7)}_C3d4`,
		`x${apiKey}`,
		`_${apiKey}`,
		`re-${"A1b2".repeat(7)}_C3d4`,
		`re_${"A1b2".repeat(3)}!${"A1b2".repeat(5)}`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("resend tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("resend tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Fly.io token formats without mistaking near-misses for tokens", async () => {
	const orgToken = `fo1_${"A1_b".repeat(10)}ABC`;
	const machineTokens = [
		`fm1a_${"A1b+/".repeat(20)}`,
		`fm1r_${"B2c+/".repeat(20)}=`,
		`fm2_${"C3d+/".repeat(20)}===`,
	];
	const sensitiveOutputs = [
		orgToken,
		...machineTokens,
		`${orgToken.slice(0, 22)}\u200b${orgToken.slice(22)}`,
	];
	for (const output of sensitiveOutputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(orgToken);
		for (const machineToken of machineTokens) expect(f.warnings.join(" ")).not.toContain(machineToken);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("fly.io tests"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("fly.io tests");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		`fo1_${"A1_b".repeat(10)}AB`,
		`${orgToken}A`,
		`x${orgToken}`,
		`${orgToken}_`,
		`fm1a_${"A1b+/".repeat(19)}xxxx`,
		`fm1x_${"A1b+/".repeat(20)}`,
		`fm2_${"A1b+/".repeat(20)}====`,
		`x${machineTokens[0]}`,
		`${machineTokens[0]}_`,
		`${machineTokens[0]}-`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("fly.io tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("fly.io tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Google API keys without mistaking near-misses for keys", async () => {
	const tokenFor = (suffix = "A".repeat(35)) => `AIza${suffix}`;
	const token = tokenFor("A1_b-".repeat(7));
	const sensitiveOutput = fixture([Promise.resolve(response(token))]);
	sensitiveOutput.input("Name a task");
	await settle();
	expect(sensitiveOutput.state.title).toBe("existing task");
	expect(sensitiveOutput.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
	expect(sensitiveOutput.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
	expect(sensitiveOutput.warnings.join(" ")).not.toContain(token);

	const ordinaryTitle = fixture([Promise.resolve(response("google api tests"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("google api tests");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		tokenFor("A".repeat(34)),
		tokenFor("A".repeat(36)),
		token.toLowerCase(),
		`x${token}`,
		`_${token}`,
		`${token}A`,
		`${token}_x`,
		`${token}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("google api tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("google api tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Google OAuth access tokens without mistaking near-misses for tokens", async () => {
	const tokenFor = (suffix = "A".repeat(32)) => `ya29.${suffix}`;
	const token = tokenFor("A1_b-".repeat(6));
	const obfuscatedToken = `ya29.${"A".repeat(16)}\u200b${"B".repeat(16)}`;
	const tokenWithContext = `Review Google OAuth access ${obfuscatedToken}`;
	expect(hasSensitiveNamingContext(tokenWithContext)).toBe(true);
	expect(hasSensitiveOutput(tokenWithContext)).toBe(true);
	for (const sensitiveToken of [token, obfuscatedToken]) {
		expect(hasSensitiveNamingContext(sensitiveToken)).toBe(true);
		expect(hasSensitiveOutput(sensitiveToken)).toBe(true);
		const f = fixture([Promise.resolve(response(sensitiveToken))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(sensitiveToken);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("google oauth tests"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("google oauth tests");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		tokenFor("A".repeat(19)),
		token.replace("ya29", "ya28"),
		`x${token}`,
		`_${token}`,
	];
	for (const nearMiss of nearMisses) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("rejects Databricks access tokens without mistaking near-miss strings for tokens", async () => {
	const token = ["dapi", "a".repeat(32)].join("");
	for (const output of [token, `${token}-2`, `rotate-${token}`, token.replace("dapi", "da\u200bpi")]) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const shortName = fixture([Promise.resolve(response("dapi"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("dapi");
	expect(shortName.warnings).toEqual([]);

	for (const output of [
		["dapi", "0".repeat(31)].join(""),
		["dapi", "0".repeat(33)].join(""),
		["dapi", "g".repeat(32)].join(""),
		`${token}_x`,
		`${token}-x`,
	]) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("databricks token tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("databricks token tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects DigitalOcean tokens without mistaking near-miss strings for tokens", async () => {
	const body = "a".repeat(64);
	const prefixes = ["doo_v1_", "dop_v1_", "dor_v1_"];
	for (const prefix of prefixes) {
		const token = `${prefix}${body}`;
		for (const output of [token, token.toUpperCase(), `rotate-${token}`, token.replace("v1", "v\u200b1")]) {
			const f = fixture([Promise.resolve(response(output))]);
			f.input("Name a task");
			await settle();
			expect(f.state.title).toBe("existing task");
			expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
			expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
			expect(f.warnings.join(" ")).not.toContain(token);
		}
	}

	const shortName = fixture([Promise.resolve(response("dop_v1_setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("dop_v1_setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = prefixes.flatMap((prefix) => [
		`${prefix}${"a".repeat(63)}`,
		`${prefix}${"a".repeat(65)}`,
		`${prefix}${"g".repeat(64)}`,
	]);
	const validToken = `${prefixes[1]}${body}`;
	nearMisses.push(`${validToken}_x`, `${validToken}-x`, `doq_v1_${body}`);
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("digitalocean token tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("digitalocean token tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Notion API tokens without mistaking near-miss strings for tokens", async () => {
	const token = ["ntn_", "1".repeat(11), "a".repeat(35)].join("");
	for (const output of [token, token.toUpperCase(), `configure-${token}`, token.replace("ntn_", "ntn_\u200b")]) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const shortName = fixture([Promise.resolve(response("ntn_api_setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("ntn_api_setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = [
		["ntn_", "1".repeat(10), "a".repeat(35)].join(""),
		["ntn_", "1".repeat(12), "a".repeat(35)].join(""),
		["ntn_", "1".repeat(11), "a".repeat(34)].join(""),
		["ntn_", "1".repeat(11), "a".repeat(36)].join(""),
		["ntn_", "a".repeat(46)].join(""),
		`${token}_x`,
		`${token}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("notion api tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("notion api tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Supabase secret keys without mistaking near-miss strings for keys", async () => {
	const token = `sb_secret_${"A".repeat(32)}`;
	const outputs = [
		token,
		`configure-${token}`,
		token.replace("sb_secret_", "sb_se\u200bcret_"),
		`${token.slice(0, 20)}\u200b${token.slice(20)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const shortName = fixture([Promise.resolve(response("supabase api setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("supabase api setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = [
		`sb_secret_${"A".repeat(31)}`,
		`sb_secret_${"A".repeat(33)}`,
		`sb_secret_${"A".repeat(32)}x`,
		`sb_secrex_${"A".repeat(32)}`,
		`sb_secret_${"A".repeat(31)}.`,
		`x${token}`,
		`_${token}`,
		`${token}_x`,
		`${token}-x`,
		`sb_publishable_${"A".repeat(32)}`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("supabase api setup"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("supabase api setup");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Neon API keys without mistaking near-miss strings for keys", async () => {
	const token = `neon_api_key_${"N".repeat(32)}`;
	const outputs = [
		token,
		`configure-${token}`,
		token.replace("neon_api_key_", "neon_api_ke\u200by_"),
		`${token.slice(0, 22)}\u200b${token.slice(22)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const shortName = fixture([Promise.resolve(response("neon api setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("neon api setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = [
		`neon_api_key_${"N".repeat(31)}`,
		`neon_api_key_${"N".repeat(33)}`,
		`neon_api_key_${"N".repeat(32)}x`,
		`neon_api_keX_${"N".repeat(32)}`,
		`neon_api_key_${"N".repeat(31)}.`,
		`x${token}`,
		`_${token}`,
		`${token}_x`,
		`${token}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("neon api setup"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("neon api setup");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Sentry organization tokens without mistaking near-misses for tokens", async () => {
	const firstClaim = "eyJpYXQiO";
	const regionClaim = "LCJyZWdpb25fdXJs";
	const tokenFor = (first = "a".repeat(20), region = regionClaim, second = "b".repeat(20), suffix = "C".repeat(43)) =>
		`sntrys_${firstClaim}${first}${region}${second}_${suffix}`;
	const token = tokenFor();
	const outputs = [
		token,
		tokenFor("a".repeat(20), "InJlZ2lvbl91cmwi"),
		tokenFor("a".repeat(20), "cmVnaW9uX3VybCI6"),
		`configure-${token}`,
		token.replace("sntrys_", "sntry\u200bs_"),
		token.replace(regionClaim, "LCJyZWdpb25fdXJ\u200bs"),
		`${token.slice(0, 45)}\u200b${token.slice(45)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const shortName = fixture([Promise.resolve(response("sentry org setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("sentry org setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = [
		tokenFor("a".repeat(9)),
		tokenFor("a".repeat(20), "LCJyZWdpb25fdXJs", "b".repeat(9)),
		tokenFor("a".repeat(20), "LCJyZWdpb25fdXls"),
		tokenFor("a".repeat(20), regionClaim, "b".repeat(20), "C".repeat(42)),
		tokenFor("a".repeat(20), regionClaim, "b".repeat(20), "C".repeat(44)),
		token.replace("sntrys_", "sntryx_"),
		`x${token}`,
		`_${token}`,
		`${token}_x`,
		`${token}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("sentry org setup"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("sentry org setup");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Sentry user access tokens without mistaking near-misses for tokens", async () => {
	const token = `sntryu_${"a".repeat(64)}`;
	const outputs = [
		token,
		`configure-${token}`,
		token.replace("sntryu_", "sntry\u200bu_"),
		`${token.slice(0, 30)}\u200b${token.slice(30)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const shortName = fixture([Promise.resolve(response("sentry api setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("sentry api setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = [
		`sntryu_${"a".repeat(63)}`,
		`sntryu_${"a".repeat(65)}`,
		`sntryu_${"a".repeat(63)}g`,
		`sntryx_${"a".repeat(64)}`,
		`x${token}`,
		`_${token}`,
		`${token}x`,
		`${token}_x`,
		`${token}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("sentry api tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("sentry api tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Telegram bot tokens without mistaking near-misses for tokens", async () => {
	const token = `123456789:A${"a".repeat(34)}`;
	const outputs = [
		token,
		`configure-${token}`,
		`${token.slice(0, 12)}\u200b${token.slice(12)}`,
		token.replace(":", ":\u200b"),
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const shortName = fixture([Promise.resolve(response("telegram bot setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("telegram bot setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = [
		`1234:A${"a".repeat(34)}`,
		`1${"2".repeat(16)}:A${"a".repeat(34)}`,
		`123456789:A${"a".repeat(33)}`,
		`123456789:A${"a".repeat(35)}`,
		`123456789:a${"a".repeat(34)}`,
		`123456789-B${"a".repeat(34)}`,
		`x${token}`,
		`_${token}`,
		`${token}x`,
		`${token}_x`,
		`${token}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("telegram bot tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("telegram bot tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Vault service and batch tokens without mistaking near-misses for tokens", async () => {
	for (const prefix of ["hvs.", "hvb."]) {
		const token = `${prefix}${"V".repeat(24)}`;
		const outputs = [
			token,
			`configure-${token}`,
			token.replace(prefix, `${prefix[0]}\u200b${prefix.slice(1)}`),
			`${token.slice(0, 11)}\u200b${token.slice(11)}`,
		];
		for (const output of outputs) {
			const f = fixture([Promise.resolve(response(output))]);
			f.input("Name a task");
			await settle();
			expect(f.state.title).toBe("existing task");
			expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
			expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
			expect(f.warnings.join(" ")).not.toContain(token);
		}

		const nearMisses = [
			`${prefix}${"V".repeat(23)}`,
			`${prefix}${"V".repeat(25)}`,
			`${prefix}${"V".repeat(24)}x`,
			`${prefix}${"V".repeat(23)}.`,
			`hvt.${"V".repeat(24)}`,
			`x${token}`,
			`_${token}`,
			`${token}_x`,
			`${token}-x`,
		];
		for (const output of nearMisses) {
			const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("vault access setup"))]);
			f.input("Name a task");
			await settle();
			expect(f.requests).toHaveLength(2);
			expect(f.state.title).toBe("vault access setup");
			expect(f.warnings).toEqual([]);
		}
	}

	const shortName = fixture([Promise.resolve(response("vault api setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("vault api setup");
	expect(shortName.warnings).toEqual([]);
});

test("rejects Brevo API tokens without mistaking near-misses for tokens", async () => {
	const token = `xkeysib-${"a".repeat(64)}-${"B".repeat(16)}`;
	const outputs = [
		token,
		token.toUpperCase(),
		`configure-${token}`,
		token.replace("xkeysib-", "xkeysib\u200b-"),
		`${token.slice(0, 40)}\u200b${token.slice(40)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const shortName = fixture([Promise.resolve(response("brevo mail setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("brevo mail setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = [
		`xkeysib-${"a".repeat(63)}-${"B".repeat(16)}`,
		`xkeysib-${"a".repeat(65)}-${"B".repeat(16)}`,
		`xkeysib-${"g".repeat(64)}-${"B".repeat(16)}`,
		`xkeysib-${"a".repeat(64)}-${"B".repeat(15)}`,
		`xkeysib-${"a".repeat(64)}-${"B".repeat(17)}`,
		`xkeysix-${"a".repeat(64)}-${"B".repeat(16)}`,
		`x${token}`,
		`_${token}`,
		`${token}x`,
		`${token}_x`,
		`${token}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("brevo mail tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("brevo mail tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Atlassian API tokens without mistaking near-misses for tokens", async () => {
	const token = `ATATT3${"a".repeat(183)}_-=`;
	const outputs = [
		token,
		token.toLowerCase(),
		`configure-${token}`,
		token.replace("ATATT3", "ATATT\u200b3"),
		`${token.slice(0, 50)}\u200b${token.slice(50)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const shortName = fixture([Promise.resolve(response("atlassian api setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("atlassian api setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = [
		`ATATT3${"a".repeat(182)}_-=`,
		`ATATT3${"a".repeat(184)}_-=`,
		`ATATT3${"a".repeat(90)}.${"a".repeat(92)}_-=`,
		`ATATT2${"a".repeat(183)}_-=`,
		`x${token}`,
		`_${token}`,
		`${token}x`,
		`${token}_x`,
		`${token}-x`,
		`${token}=x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("atlassian api tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("atlassian api tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Terraform Cloud API tokens without mistaking near-misses for tokens", async () => {
	const prefix = "T".repeat(14);
	const token60 = `${prefix}.atlasv1.${"a".repeat(57)}_-=`;
	const token70 = `${prefix}.atlasv1.${"b".repeat(67)}_-=`;
	const mixedCaseToken = `${"q".repeat(14)}.atlasv1.${"A".repeat(60)}`;
	const tokens = [token60, token70, mixedCaseToken];
	for (const token of tokens) {
		const outputs = [
			token,
			token.replace(".atlasv1.", ".ATLASV1."),
			`${token}!`,
			`deploy-${token}`,
			token.replace(".atlasv1.", ".atla\u200bsv1."),
			`${token.slice(0, 24)}\u200b${token.slice(24)}`,
		];
		for (const output of outputs) {
			const f = fixture([Promise.resolve(response(output))]);
			f.input("Name a task");
			await settle();
			expect(f.state.title).toBe("existing task");
			expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
			expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
			expect(f.warnings.join(" ")).not.toContain(token);
		}
	}

	const shortName = fixture([Promise.resolve(response("terraform cloud setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("terraform cloud setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = [
		`${"a".repeat(13)}.atlasv1.${"c".repeat(60)}`,
		`${"a".repeat(15)}.atlasv1.${"c".repeat(60)}`,
		`${prefix}.atlasv1.${"c".repeat(59)}`,
		`${prefix}.atlasv1.${"c".repeat(71)}`,
		`${prefix}.atlasv1.${"c".repeat(30)}.${"c".repeat(30)}`,
		`${prefix}.atlasv2.${"c".repeat(60)}`,
		`x${token60}`,
		`_${token60}`,
		`${token70}x`,
		`${token70}_x`,
		`${token70}-x`,
		`${token70}=x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("terraform cloud tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("terraform cloud tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Shopify app tokens without mistaking near-miss strings for tokens", async () => {
	const prefixes = ["shpat_", "shpca_", "shppa_", "shpss_"];
	const tokenFor = (prefix: string) => `${prefix}${"a".repeat(32)}`;
	for (const prefix of prefixes) {
		const token = tokenFor(prefix);
		const outputs = [
			token,
			token.toUpperCase(),
			`configure-${token}`,
			token.replace("shp", "sh\u200bp"),
			`${token.slice(0, 20)}\u200b${token.slice(20)}`,
		];
		for (const output of outputs) {
			const f = fixture([Promise.resolve(response(output))]);
			f.input("Name a task");
			await settle();
			expect(f.state.title).toBe("existing task");
			expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
			expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
			expect(f.warnings.join(" ")).not.toContain(token);
		}
	}

	const shortName = fixture([Promise.resolve(response("shopify app setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("shopify app setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = prefixes.flatMap((prefix) => {
		const token = tokenFor(prefix);
		return [
			`${prefix}${"a".repeat(31)}`,
			`${prefix}${"a".repeat(33)}`,
			`${prefix}${"g".repeat(32)}`,
			`${prefix.replace(/.$/u, "x")}${"a".repeat(32)}`,
			`x${token}`,
			`_${token}`,
			`${token}x`,
			`${token}_x`,
			`${token}-x`,
		];
	});
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("shopify app tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("shopify app tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Shippo API tokens without mistaking near-miss strings for tokens", async () => {
	const tokenFor = (mode: string, body = "a".repeat(40)) => `shippo_${mode}_${body}`;
	const tokens = [tokenFor("live"), tokenFor("test")];
	for (const token of tokens) {
		const outputs = [
			token,
			token.toUpperCase(),
			`configure-${token}`,
			token.replace("shippo", "shi\u200bppo"),
			`${token.slice(0, 24)}\u200b${token.slice(24)}`,
		];
		for (const output of outputs) {
			const f = fixture([Promise.resolve(response(output))]);
			f.input("Name a task");
			await settle();
			expect(f.state.title).toBe("existing task");
			expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
			expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
			expect(f.warnings.join(" ")).not.toContain(token);
		}
	}

	const shortName = fixture([Promise.resolve(response("shippo label setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("shippo label setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = [
		tokenFor("live", "a".repeat(39)),
		tokenFor("test", "a".repeat(41)),
		tokenFor("live", "g".repeat(40)),
		tokenFor("sandbox"),
		`x${tokens[0]}`,
		`_${tokens[0]}`,
		`${tokens[0]}x`,
		`${tokens[0]}_x`,
		`${tokens[0]}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("shippo label tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("shippo label tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects PlanetScale API and OAuth tokens without mistaking near-misses for tokens", async () => {
	const tokenFor = (kind: string, body: string) => `pscale_${kind}_${body}`;
	const body32 = "A1_bc.-=".repeat(4);
	const body64 = "B".repeat(64);
	const tokens = [tokenFor("tkn", body32), tokenFor("tkn", body64), tokenFor("oauth", body32), tokenFor("oauth", body64)];
	for (const token of tokens) {
		const outputs = [
			token,
			token.toUpperCase(),
			`configure-${token}`,
			token.replace("pscale", "p\u200bscale"),
			`${token.slice(0, 25)}\u200b${token.slice(25)}`,
		];
		for (const output of outputs) {
			const f = fixture([Promise.resolve(response(output))]);
			f.input("Name a task");
			await settle();
			expect(f.state.title).toBe("existing task");
			expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
			expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
			expect(f.warnings.join(" ")).not.toContain(token);
		}
	}

	const ordinaryTitle = fixture([Promise.resolve(response("planetscale migration"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("planetscale migration");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		tokenFor("tkn", "A".repeat(31)),
		tokenFor("oauth", "A".repeat(65)),
		tokenFor("token", body32),
		`x${tokens[0]}`,
		`_${tokens[0]}`,
		`${tokens[1]}x`,
		`${tokens[1]}_x`,
		`${tokens[1]}-x`,
		`${tokens[1]}.x`,
		`${tokens[1]}=x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("scale migration tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("scale migration tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Postman API tokens without mistaking near-misses for tokens", async () => {
	const tokenFor = (first = "a".repeat(24), second = "b".repeat(34)) => `PMAK-${first}-${second}`;
	const token = tokenFor();
	const outputs = [
		token,
		token.toLowerCase(),
		token.toUpperCase(),
		`configure-${token}`,
		token.replace("PMAK", "PM\u200bAK"),
		`${token.slice(0, 35)}\u200b${token.slice(35)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("postman auth tests"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("postman auth tests");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		tokenFor("a".repeat(23)),
		tokenFor("a".repeat(25)),
		tokenFor("a".repeat(24), "b".repeat(33)),
		tokenFor("a".repeat(24), "b".repeat(35)),
		tokenFor("g".repeat(24)),
		tokenFor("a".repeat(24), "g".repeat(34)),
		token.replace("PMAK-", "XMAK-"),
		token.replace("PMAK-", "PMAK_"),
		`x${token}`,
		`_${token}`,
		`${token}x`,
		`${token}_x`,
		`${token}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("postman auth tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("postman auth tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Prefect API tokens without mistaking near-misses for tokens", async () => {
	const tokenFor = (body = "A1b2".repeat(9)) => `pnu_${body}`;
	const token = tokenFor();
	const outputs = [
		token,
		token.toUpperCase(),
		`configure-${token}`,
		token.replace("pnu", "p\u200bnu"),
		`${token.slice(0, 18)}\u200b${token.slice(18)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("prefect deployment tests"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("prefect deployment tests");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		tokenFor("A".repeat(35)),
		tokenFor("A".repeat(37)),
		tokenFor("A".repeat(35) + "_"),
		tokenFor("A".repeat(35) + "-"),
		token.replace("pnu_", "pnu-"),
		`x${token}`,
		`_${token}`,
		`${token}x`,
		`${token}_x`,
		`${token}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("prefect deployment tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("prefect deployment tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Octopus Deploy API keys without mistaking near-misses for keys", async () => {
	const tokenFor = (body = "A1B2".repeat(6) + "A1") => `API-${body}`;
	const token = tokenFor();
	const outputs = [
		token,
		`configure-${token}`,
		token.replace("API", "A\u200bPI"),
		`${token.slice(0, 18)}\u200b${token.slice(18)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("octopus deployment tests"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("octopus deployment tests");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		tokenFor("A".repeat(25)),
		tokenFor("A".repeat(27)),
		tokenFor("A".repeat(25) + "_"),
		tokenFor("A".repeat(25) + "-"),
		token.toLowerCase(),
		token.replace("API-", "API_"),
		`x${token}`,
		`_${token}`,
		`${token}X`,
		`${token}_X`,
		`${token}-X`,
		`${token}x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("octopus deployment tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("octopus deployment tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Pulumi API tokens without mistaking near-misses for tokens", async () => {
	const tokenFor = (body = "a".repeat(40)) => `pul-${body}`;
	const token = tokenFor();
	const outputs = [
		token,
		token.toUpperCase(),
		`configure-${token}`,
		token.replace("pul", "p\u200bul"),
		`${token.slice(0, 18)}\u200b${token.slice(18)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("pulumi stack tests"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("pulumi stack tests");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		tokenFor("a".repeat(39)),
		tokenFor("a".repeat(41)),
		tokenFor("g".repeat(40)),
		token.replace("pul-", "pum-"),
		`x${token}`,
		`_${token}`,
		`${token}x`,
		`${token}_x`,
		`${token}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("pulumi stack tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("pulumi stack tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Sourcegraph access tokens without mistaking near-miss strings for tokens", async () => {
	const tokens = [
		`sgp_${"a".repeat(40)}`,
		`sgp_${"b".repeat(16)}_${"c".repeat(40)}`,
		`sgp_local_${"d".repeat(40)}`,
	];
	for (const token of tokens) {
		const outputs = [
			token,
			token.toUpperCase(),
			`configure-${token}`,
			token.replace("sgp_", "sg\u200bp_"),
			`${token.slice(0, 12)}\u200b${token.slice(12)}`,
		];
		for (const output of outputs) {
			const f = fixture([Promise.resolve(response(output))]);
			f.input("Name a task");
			await settle();
			expect(f.state.title).toBe("existing task");
			expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
			expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
			expect(f.warnings.join(" ")).not.toContain(token);
		}
	}

	const shortName = fixture([Promise.resolve(response("sourcegraph api setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("sourcegraph api setup");
	expect(shortName.warnings).toEqual([]);

	const token = tokens[0]!;
	const segmentedToken = tokens[1]!;
	const localToken = tokens[2]!;
	const nearMisses = [
		`sgp_${"a".repeat(39)}`,
		`sgp_${"a".repeat(41)}`,
		`sgp_${"g".repeat(40)}`,
		`sgp_${"a".repeat(15)}_${"b".repeat(40)}`,
		`sgp_${"a".repeat(17)}_${"b".repeat(40)}`,
		`sgp_${"a".repeat(16)}_${"b".repeat(39)}`,
		`sgp_${"a".repeat(16)}_${"b".repeat(41)}`,
		`sgp_local_${"c".repeat(39)}`,
		`sgp_local_${"c".repeat(41)}`,
		`sgp_locax_${"c".repeat(40)}`,
		`sgr_${"a".repeat(40)}`,
		`x${token}`,
		`_${token}`,
		`${token}x`,
		`${token}_x`,
		`${token}-x`,
		`${segmentedToken}x`,
		`${segmentedToken}_x`,
		`${localToken}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("sourcegraph api tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("sourcegraph api tests");
		expect(f.warnings).toEqual([]);
	}

	const commitHash = "a".repeat(40);
	expect(hasSensitiveNamingContext(`Review commit ${commitHash}`)).toBe(false);
	expect(hasSensitiveOutput(commitHash)).toBe(false);
});

test("rejects SendGrid API keys without mistaking near-miss strings for keys", async () => {
	const token = `SG.${"a".repeat(66)}`;
	const outputs = [
		token,
		token.toLowerCase(),
		`configure-${token}`,
		token.replace("SG.", "SG.\u200b"),
		`${token.slice(0, 33)}\u200b${token.slice(33)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const shortName = fixture([Promise.resolve(response("sg_api_setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("sg_api_setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = [
		`SG.${"a".repeat(65)}`,
		`SG.${"a".repeat(67)}`,
		`SX.${"a".repeat(66)}`,
		`SG.${"a".repeat(65)}+`,
		`${token}x`,
		`${token}_x`,
		`x${token}`,
		`_${token}`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("sendgrid api tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("sendgrid api tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Linear API tokens without mistaking near-miss strings for tokens", async () => {
	const token = `lin_api_${"aA09".repeat(10)}`;
	const outputs = [
		token,
		token.toUpperCase(),
		`configure-${token}`,
		token.replace("lin_api_", "lin_api_\u200b"),
		`${token.slice(0, 25)}\u200b${token.slice(25)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const shortName = fixture([Promise.resolve(response("lin_api_setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("lin_api_setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = [
		`lin_api_${"a".repeat(39)}`,
		`lin_api_${"a".repeat(41)}`,
		`linx_api_${"a".repeat(40)}`,
		`lin_api_${"a".repeat(39)}_`,
		`${token}x`,
		`${token}_x`,
		`${token}-x`,
		`x${token}`,
		`_${token}`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("linear api tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("linear api tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Twilio API keys without mistaking near-miss strings for keys", async () => {
	const token = `SK${"a1".repeat(16)}`;
	const outputs = [
		token,
		token.toLowerCase(),
		`configure-${token}`,
		token.replace("SK", "S\u200bK"),
		`${token.slice(0, 17)}\u200b${token.slice(17)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const shortName = fixture([Promise.resolve(response("sk_api_setup"))]);
	shortName.input("Name a task");
	await settle();
	expect(shortName.requests).toHaveLength(1);
	expect(shortName.state.title).toBe("sk_api_setup");
	expect(shortName.warnings).toEqual([]);

	const nearMisses = [
		`SK${"a".repeat(31)}`,
		`SK${"a".repeat(33)}`,
		`SX${"a".repeat(32)}`,
		`SK${"g".repeat(32)}`,
		`${token}x`,
		`${token}_x`,
		`x${token}`,
		`_${token}`,
		`c${token}`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("twilio api tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("twilio api tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Cloudflare Origin CA keys without mistaking near-miss strings for keys", async () => {
	const firstSegment = "a".repeat(24);
	const secondSegment = "b".repeat(146);
	const token = ["v1.0-", firstSegment, "-", secondSegment].join("");
	const outputs = [
		token,
		token.toUpperCase(),
		`configure-${token}`,
		token.replace("v1.0-", "v1.0-\u200b"),
		`${token.slice(0, 50)}\u200b${token.slice(50)}`,
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("cloudflare origin tests"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("cloudflare origin tests");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		`v1.0-${"a".repeat(23)}-${secondSegment}`,
		`v1.0-${"a".repeat(25)}-${secondSegment}`,
		`v1.0-${firstSegment}-${"b".repeat(145)}`,
		`v1.0-${firstSegment}-${"b".repeat(147)}`,
		`v1.0-${"g".repeat(24)}-${secondSegment}`,
		`v1.0-${firstSegment}-${"g".repeat(146)}`,
		`v1.1-${firstSegment}-${secondSegment}`,
		`${token}x`,
		`${token}_x`,
		`${token}-x`,
		`x${token}`,
		`_${token}`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("cloudflare origin tests"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("cloudflare origin tests");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Doppler personal tokens without mistaking near-miss strings for tokens", async () => {
	const prefix = ["dp", ".", "pt", "."].join("");
	const token = `${prefix}${"a".repeat(43)}`;
	const outputs = [
		token,
		token.toUpperCase(),
		`configure-${token}`,
		token.replace("pt.", "pt.\u200b"),
		token.replace(prefix, `dp.\u200bpt.`),
	];
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(token);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("doppler client settings"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("doppler client settings");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		`${prefix}${"a".repeat(42)}`,
		`${prefix}${"a".repeat(44)}`,
		`${prefix}${"a".repeat(42)}!`,
		`${prefix}${"a".repeat(42)}_`,
		`${prefix}${"a".repeat(42)}-`,
		`x${token}`,
		`_${token}`,
		`${token}x`,
		`${token}_x`,
		`${token}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("doppler client settings"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("doppler client settings");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects 1Password Secret Keys without mistaking near-miss strings for keys", async () => {
	const six = "A".repeat(6);
	const eleven = "B".repeat(11);
	const five = "C".repeat(5);
	const fiveGroups = ["A3", six, eleven, five, five, five];
	const token = fiveGroups.join("-");
	const alternate = ["A3", six, "D".repeat(6), "E".repeat(5), five, five, five].join("-");
	const outputs = [
		token,
		token.toLowerCase(),
		alternate,
		`configure-${token}`,
		token.replace("A3-", "A3-\u200b"),
		token.replace(six, `${six}\u200b`),
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

	const ordinaryTitle = fixture([Promise.resolve(response("1password vault"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("1password vault");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		["A3", "A".repeat(5), eleven, five, five, five].join("-"),
		["A3", "A".repeat(7), eleven, five, five, five].join("-"),
		["A3", six, "B".repeat(10), five, five, five].join("-"),
		["A3", six, "B".repeat(12), five, five, five].join("-"),
		["A3", six, "D".repeat(6), "E".repeat(4), five, five, five].join("-"),
		["A3", six, eleven, "C".repeat(4), five, five].join("-"),
		["B3", six, eleven, five, five, five].join("-"),
		`${token}x`,
		`${token}_x`,
		`${token}-x`,
		`x${token}`,
		`_${token}`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("1password vault"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("1password vault");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects age secret keys without mistaking near-miss strings for identities", async () => {
	const prefix = ["AGE", "SECRET", "KEY", "1"].join("-");
	const payload = "Q".repeat(58);
	const identity = `${prefix}${payload}`;
	const outputs = [
		identity,
		identity.toLowerCase(),
		`configure-${identity}`,
		identity.replace(prefix, `${prefix}\u200b`),
		`${identity.slice(0, 45)}\u200b${identity.slice(45)}`,
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

	const ordinaryTitle = fixture([Promise.resolve(response("age key migration"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("age key migration");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		`${prefix}${"Q".repeat(57)}`,
		`${prefix}${"Q".repeat(59)}`,
		`${prefix}${"I"}${"Q".repeat(57)}`,
		`${prefix}${"O"}${"Q".repeat(57)}`,
		`${prefix.slice(0, -1)}2${payload}`,
		`x${identity}`,
		`_${identity}`,
		`${identity}x`,
		`${identity}_x`,
		`${identity}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("age key migration"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("age key migration");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Adobe client secrets without mistaking near-miss strings for secrets", async () => {
	const prefix = ["p8e", "-"].join("");
	const alphabet = "aB3cD5eF7gH9jK2mN4pQ6rS8tU1vW0x";
	const body = alphabet.repeat(2).slice(0, 32);
	const secret = `${prefix}${body}`;
	const outputs = [
		secret,
		secret.toUpperCase(),
		`configure-${secret}`,
		secret.replace(prefix, `${prefix}\u200b`),
		`${secret.slice(0, 20)}\u200b${secret.slice(20)}`,
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

	const ordinaryTitle = fixture([Promise.resolve(response("adobe oauth migration"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("adobe oauth migration");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		`${prefix}${body.slice(0, 31)}`,
		`${prefix}${body}a`,
		`${prefix}${body.slice(1)}!`,
		`${prefix}${body.slice(1)}_`,
		`${["p8f", "-"].join("")}${body}`,
		`x${secret}`,
		`_${secret}`,
		`${secret}x`,
		`${secret}_x`,
		`${secret}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("adobe oauth migration"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("adobe oauth migration");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects Grafana tokens without mistaking near-miss strings for tokens", async () => {
	const alphabet = "aB3cD5eF7gH9jK2mN4pQ6rS8tU1vW0x";
	const serviceBody = alphabet.repeat(2).slice(0, 32);
	const apiKey = `eyJrIjoi${alphabet.repeat(3).slice(0, 70)}`;
	const cloudToken = `glc_${"/+AbC0123".repeat(4)}`;
	const serviceToken = `glsa_${serviceBody}_A1B2C3D4`;
	const tokens = [apiKey, cloudToken, serviceToken];
	const outputs = tokens.flatMap((token) => [
		token,
		token.toUpperCase(),
		`configure-${token}`,
		`${token.slice(0, 12)}\u200b${token.slice(12)}`,
	]);
	for (const output of outputs) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(output);
	}

	const ordinaryTitle = fixture([Promise.resolve(response("grafana alerts"))]);
	ordinaryTitle.input("Name a task");
	await settle();
	expect(ordinaryTitle.requests).toHaveLength(1);
	expect(ordinaryTitle.state.title).toBe("grafana alerts");
	expect(ordinaryTitle.warnings).toEqual([]);

	const nearMisses = [
		`eyJrIjoi${alphabet.repeat(3).slice(0, 69)}`,
		`eyJrIjoi${alphabet.repeat(13).slice(0, 401)}`,
		`${apiKey}====`,
		`${["eyJrIji", "i"].join("")}${alphabet.repeat(3).slice(0, 70)}`,
		`glc_${"/+AbC0123".repeat(4).slice(0, 31)}`,
		`glc_${"/+AbC0123".repeat(45).slice(0, 401)}`,
		`${cloudToken.slice(0, 18)}?${cloudToken.slice(19)}`,
		`${["glx", "_"].join("")}${"/+AbC0123".repeat(4)}`,
		`glsa_${serviceBody.slice(0, 31)}_A1B2C3D4`,
		`glsa_${serviceBody}_A1B2C3D`,
		`glsa_${serviceBody}_A1B2C3D4F`,
		`glsa_${serviceBody}_A1B2C3DG`,
		`${["glsb", "_"].join("")}${serviceBody}_A1B2C3D4`,
		`x${apiKey}`,
		`_${cloudToken}`,
		`${serviceToken}x`,
		`${serviceToken}_x`,
		`${serviceToken}-x`,
	];
	for (const output of nearMisses) {
		const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("grafana alerts"))]);
		f.input("Name a task");
		await settle();
		expect(f.requests).toHaveLength(2);
		expect(f.state.title).toBe("grafana alerts");
		expect(f.warnings).toEqual([]);
	}
});

test("rejects phone-shaped output only when a phone label is present", async () => {
	const labeledNumbers = [
		"Phone: 000-000-0000",
		"Mobile Number=0000000000",
		"cellular_number: (000) 000-0000",
		"Telephone: +1 (000) 000-0000",
		"phone: 0000000",
		"Phone: ０００-０００-００００",
		"Phone: 000-\u200b000-0000",
		"Phone:\u200b 000-000-0000",
	];
	for (const output of labeledNumbers) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(output);
	}
});

test("rejects Luhn-valid payment-card-shaped output only with an explicit card label", async () => {
	const labeledNumbers = [
		"Card Number: 0000 0000 0000 0000",
		"Credit Card=0000000000000000",
		"debit_card_number: 0000-0000-0000-0000",
		"Payment Card No: 0000 0000 0000 0000",
		"cc number=0000000000000000",
		"CCN: 0000000000000000",
		"CCN: 0000000000000",
		"CCN: 0000000000000000000",
		"Card Number: ００００-００００-００００-００００",
		"Card Number:\u200b 0000-0000-0000-0000",
		"Card Number: 0000-0000-0000-\u200b0000",
	];
	for (const output of labeledNumbers) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(output);
	}

	const fragments = ["Card Number: 0000-0000-", "0000-0000"];
	const splitResponse = {
		...response(""),
		content: fragments.map((text, index) => ({
			type: "text",
			text,
			textSignature: JSON.stringify({ v: 1, id: `card-${index}`, phase: "final_answer" }),
		})),
	};
	const split = fixture([Promise.resolve(splitResponse)]);
	split.input("Name a task");
	await settle();
	expect(split.state.title).toBe("existing task");
	expect(split.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
});

test.each([
	["short suffix", ["r8_", "P".repeat(36)].join("")],
	["long suffix", ["r8_", "Q".repeat(38)].join("")],
	["trailing identifier glue", `${["r8_", "R".repeat(37)].join("")}_x`],
])("does not classify %s as a Replicate API token", async (_shape, output) => {
	const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("fix auth tests"))]);
	f.input("Name a task");
	await settle();
	expect(f.requests).toHaveLength(2);
	expect(f.state.title).toBe("fix auth tests");
	expect(f.warnings).toEqual([]);
});

test("does not join prose after a label into an opaque credential", async () => {
	const f = fixture([
		Promise.resolve(response("api key: rotate integration tests after every release")),
		Promise.resolve(response("fix auth tests")),
	]);
	f.input("Name a task");
	await settle();
	expect(f.requests).toHaveLength(2);
	expect(f.state.title).toBe("fix auth tests");
	expect(f.warnings).toEqual([]);
});

test.each([
	["Pinecone-style prefix", ["p", "csk_", "A".repeat(48)].join("")],
	["alphanumeric leading glue", `x${["csk-", "B".repeat(48)].join("")}`],
	["underscore leading glue", `_${["csk_", "C".repeat(48)].join("")}`],
	["hyphen leading glue", `-${["csk-", "D".repeat(48)].join("")}`],
	["short body", ["csk_", "E".repeat(47)].join("")],
	["long body", ["csk-", "F".repeat(49)].join("")],
	["trailing identifier glue", `${["csk_", "H".repeat(48)].join("")}x`],
])("does not classify %s as a Cerebras API key", async (_shape, output) => {
	const f = fixture([Promise.resolve(response(output)), Promise.resolve(response("fix auth tests"))]);
	f.input("Name a task");
	await settle();
	expect(f.requests).toHaveLength(2);
	expect(f.state.title).toBe("fix auth tests");
	expect(f.warnings).toEqual([]);
});

test("email-address-like model output is rejected before normalization and not disclosed", async () => {
	const address = ["person", "@", "example", ".", "invalid"].join("");
	for (const output of [address, `${address}_x`, "person @example.invalid"]) {
		const f = fixture([Promise.resolve(response(output))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.warnings).toEqual(["Sensitive-looking naming output was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(address);
	}

	const splitAddress = ["pi-tmux", "@", "example", ".", "invalid"].join("");
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
	expect(f.warnings.join(" ")).not.toContain(splitAddress);
});

test("ordinary security-themed and hyphenated task titles without credential values remain valid", async () => {
	for (const [title, expected] of [
		["review bearer auth flow", "review bearer auth flow"],
		["bearer authentication v2", "bearer authentication v2"],
		["groq api authentication", "groq api authentication"],
		["nvidia api keys", "nvidia api keys"],
		["nvapi-short-token", "nvapi-short-token"],
		["api key setup", "api key setup"],
		["access token flow", "access token flow"],
		["api_key=example", "api_key example"],
		["password: placeholder", "password placeholder"],
		["passphrase=example", "passphrase example"],
		["token: placeholder", "token placeholder"],
		["token: rotate safely", "token rotate safely"],
		["ssn parser tests", "ssn parser tests"],
		["social security format", "social security format"],
		["ssn: placeholder", "ssn placeholder"],
		["ticket 000-00-0000", "ticket 000-00-0000"],
		["ticket 000-000-0000", "ticket 000-000-0000"],
		["000-000-0000", "000-000-0000"],
		["headphone: 0000000", "headphone 0000000"],
		["phone: 000-000", "phone 000-000"],
		["phone parsing", "phone parsing"],
		["credit card tests", "credit card tests"],
		["credit card: placeholder", "credit card placeholder"],
		["0000 0000 0000 0000", "0000 0000 0000 0000"],
		["ccn: 0000000000001", "ccn 0000000000001"],
		["card number: 000000000000", "card number 000000000000"],
		["ccn: 00000000000000000000", "ccn 00000000000000000000"],
		["replicate api tests", "replicate api tests"],
		["r8 token setup", "r8 token setup"],
		["fireworks api keys", "fireworks api keys"],
		["fw key setup", "fw key setup"],
		["fpk file format", "fpk file format"],
		["xai api integration", "xai api integration"],
		["pplx-decider-v1", "pplx-decider-v1"],
		["task-based development", "task-based development"],
		["task-based-development", "task-based-development"],
		["work-based-development", "work-based-development"],
	] as const) {
		const f = fixture([Promise.resolve(response(title))]);
		f.input("Name a task");
		await settle();
		expect(f.state.title).toBe(expected);
		expect(f.warnings).toEqual([]);
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

test.each([
	{ setting: " Fish & Shell ", expected: "fish shell" },
	{ setting: "!!!", expected: "zsh" },
	{ setting: "My Very Very Long Window Title", expected: "my very very long" },
])("quit cleanup uses sanitized PI_TMUX_IDLE_TITLE: %j", async ({ setting, expected }) => {
	process.env.PI_TMUX_IDLE_TITLE = setting;
	const f = fixture([]);
	await f.emit("session_start");
	await f.emit("session_shutdown", "quit");
	expect(f.state.title).toBe(expected);
	expect(f.calls.at(-1)).toEqual(["rename-window", "-t", "%1", "--", buildQuitTitleFormat(expected)]);
});

test("sensitive-looking idle titles are replaced by zsh before cleanup", async () => {
	process.env.PI_TMUX_IDLE_TITLE = ["ghp_", "A".repeat(20)].join("");
	const f = fixture([]);
	await f.emit("session_start");
	await f.emit("session_shutdown", "quit");
	expect(f.state.title).toBe("zsh");
	expect(f.calls.at(-1)).toEqual(["rename-window", "-t", "%1", "--", buildQuitTitleFormat("zsh")]);
	expect(f.warnings).toEqual([]);
});

test("credential-bearing URLs in idle titles fall back without disclosure", async () => {
	process.env.PI_TMUX_IDLE_TITLE = "postgres://test-user:example-only-password@db.example.test/app";
	const f = fixture([]);
	await f.emit("session_start");
	await f.emit("session_shutdown", "quit");
	expect(f.state.title).toBe("zsh");
	expect(f.calls.at(-1)).toEqual(["rename-window", "-t", "%1", "--", buildQuitTitleFormat("zsh")]);
});

test("obfuscated sensitive idle titles also fall back without disclosure", async () => {
	process.env.PI_TMUX_IDLE_TITLE = `ghp_${"B".repeat(10)}\u200b${"B".repeat(10)}`;
	const f = fixture([]);
	await f.emit("session_start");
	await f.emit("session_shutdown", "quit");
	expect(f.state.title).toBe("zsh");
	expect(f.calls.at(-1)).toEqual(["rename-window", "-t", "%1", "--", buildQuitTitleFormat("zsh")]);
});

test("idle title configuration is reread by a fresh extension runtime", async () => {
	process.env.PI_TMUX_IDLE_TITLE = "Fish Shell";
	const f = fixture([]);
	process.env.PI_TMUX_IDLE_TITLE = "Bash Shell";
	await f.emit("session_start");
	await f.emit("session_shutdown", "quit");
	expect(f.state.title).toBe("fish shell");

	f.load();
	await f.emit("session_start", "reload");
	await f.emit("session_shutdown", "quit");
	expect(f.state.title).toBe("bash shell");
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
	expect(f.state.windowBaseName).toBe("zsh");
});

test("session startup preserves an unmarked custom window name", async () => {
	const f = fixture();
	f.state.title = "Custom Manual Name";
	await f.emit("session_start");
	expect(f.state.title).toBe("Custom Manual Name");
	expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
});

test("waiting markers preserve custom window text when no task title is available", async () => {
	process.env.PI_TMUX_MODEL = "off";
	const f = fixture();
	const customTitle = "Custom Build Server Name Exceeding the 24 Character Task Limit";
	f.state.title = customTitle;
	await f.emit("agent_settled");
	expect(f.state.title).toBe(`${READY_PREFIX}${customTitle}`);
	expect(f.requests).toHaveLength(0);
	f.emit("agent_start");
	await settle();
	expect(f.state.title).toBe(customTitle);
	expect(f.warnings).toEqual([]);
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
	expect(f.calls.filter((args) => args[0] === "rename-window").at(-1)).toEqual(renameCommand("fix auth tests"));
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
	expect(f.calls.filter((args) => args[0] === "rename-window").at(-1)).toEqual(renameCommand("new task"));
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
	expect(f.calls.filter((args) => args[0] === "set-option" && args.includes("rename-session")).at(-1)?.[16]).toBe("%1");
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

test("projection-aware naming context reads the checkpoint summary and skips older history", () => {
	let readDiscardedRole = false;
	const discarded = {} as any;
	Object.defineProperty(discarded, "role", {
		get() {
			readDiscardedRole = true;
			throw new Error("Older messages should not be scanned after the retained window is full");
		},
	});
	const summary = { role: "compactionSummary", summary: "Compacted auth task" };
	const recent = Array.from({ length: MAX_HISTORY_MESSAGES }, (_, i) => ({ role: "user", content: `recent-${i}` }));
	const messages = [summary, discarded, ...recent] as any;
	const projection = {
		entries: [{ sourceEntry: { type: "compaction" }, messages: [summary] }],
		messages,
		thinkingLevel: "off",
		model: null,
	} as any;

	const context = buildNamingContext(projection);
	expect(context).toBe([
		"summary: Compacted auth task",
		...recent.map((message) => `user: ${message.content}`),
	].join("\n\n"));
	expect(readDiscardedRole).toBe(false);
});

test("projection naming context bounds scans through long tool-only runs", () => {
	let readOlderRole = false;
	const older = {} as any;
	Object.defineProperty(older, "role", {
		get() {
			readOlderRole = true;
			throw new Error("A tool-heavy history scan should stop at its budget");
		},
	});
	const recent = { role: "user", content: "recent task" };
	const messages = [older, ...Array.from({ length: 5_000 }, () => ({ role: "toolResult" })), recent];
	const projection = {
		entries: [{ sourceEntry: { type: "message" }, messages: [] }],
		messages,
		thinkingLevel: "off",
		model: null,
	} as any;

	expect(buildNamingContext(projection, "continue")).toBe("user: recent task\n\nuser: continue");
	expect(readOlderRole).toBe(false);
});

test("messages-only naming context still finds compaction summaries in long histories", () => {
	const messages = [
		{ role: "compactionSummary", summary: "preserved summary" },
		...Array.from({ length: 5_000 }, () => ({ role: "toolResult" })),
		{ role: "user", content: "recent task" },
	];

	expect(buildNamingContext(messages as any)).toBe("summary: preserved summary\n\nuser: recent task");
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

test("naming context bounds leading-whitespace scans", () => {
	const context = buildNamingContext([{
		role: "user",
		content: " ".repeat(10_000) + "hidden task",
	}] as any, "continue");

	expect(context).toBe("user: continue");
});

test("naming context stops after its content-block scan budget", () => {
	let readExcessBlock = false;
	const excess = {} as any;
	Object.defineProperty(excess, "type", {
		get() {
			readExcessBlock = true;
			throw new Error("Content blocks beyond the scan budget should not be read");
		},
	});
	const content = [...Array.from({ length: 128 }, () => ({ type: "image" })), excess];

	expect(buildNamingContext([{ role: "user", content }] as any)).toBe("");
	expect(readExcessBlock).toBe(false);
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

test("manual titles reject sensitive text before normalization without disclosing it", async () => {
	const token = ["ghp_", "A".repeat(20)].join("");
	const sensitiveTitles = [
		token,
		`auth integration ${token}`,
		`shippo_live_${"a".repeat(40)}`,
		`shippo_test_${"b".repeat(40)}`,
		`pscale_tkn_${"C".repeat(32)}`,
		`pscale_oauth_${"D".repeat(64)}`,
		`PMAK-${"a".repeat(24)}-${"b".repeat(34)}`,
		`pul-${"a".repeat(40)}`,
		`pnu_${"A1b2".repeat(9)}`,
		`API-${"A1B2".repeat(6)}A1`,
		`AIza${"A".repeat(35)}`,
		`Datadog: ${"A1b2".repeat(10)}`,
		`Mailgun: key-${"a1b2".repeat(8)}`,
		`AKCp${"A1b2".repeat(17)}A`,
		`cmVmd${"C1d2".repeat(14)}AbC`,
		`fo1_${"A1_b".repeat(10)}ABC`,
		`fm1a_${"A1b+/".repeat(20)}`,
		`fm1r_${"B2c+/".repeat(20)}=`,
		`fm2_${"C3d+/".repeat(20)}===`,
		`dt0c01.${"A1b2".repeat(6)}.${"C3d4".repeat(16)}`,
		`re_${"A1b2".repeat(7)}_C3d4`,
		`client_secret=${"B".repeat(24)}`,
		`AWS_SECRET_ACCESS_KEY=${"A".repeat(40)}`,
		`AWS_SECRET_ACCESS_KEY: |-\n  ${"A".repeat(22)}\n  ${"B".repeat(22)}`,
		`AccountKey=${"A".repeat(86)}==`,
		`client-key-data: ${"A".repeat(44)}`,
		`client-key-data: |-\n  ${"A".repeat(10)}\n  ${"A".repeat(10)}\n  ${"A".repeat(44)}`,
		`PresharedKey=${"A".repeat(43)}=`,
		basicAuthorizationHeader("Authorization", `u:${"p".repeat(20)}`),
		basicAuthorizationHeader("Proxy-Authorization", `p:${"w".repeat(20)}`),
		basicAuthorizationHeader("Authorization", "u:p"),
		basicAuthorizationHeader("Proxy-Authorization", "p:w"),
		`https://storage.example.test/blob?sv=2023-11-03&sig=${"A".repeat(43)}=`,
		`password=secret phrase`,
		`password=secret phrase: keep this private`,
		`password: "secret phrase"`,
		`passphrase: silver owl`,
		`password: secret\n  phrase`,
		`password=secret phrase, keep this private`,
		`passphrase: silver owl; do not copy it`,
		`password: secret\n  phrase, keep this private`,
		`password: |-\n  ${"P".repeat(12)}`,
		`password: |-\n  secret phrase`,
		`passphrase: &words >-\n  moonlight\n  meadow`,
		`password: !!str |-\n  ${"P".repeat(12)}`,
		`token: &task-token >-\n  ${"T".repeat(24)}`,
		`Authorization: |-\n  Basic ${Buffer.from("u:p").toString("base64")}`,
		`Authorization: !!str |-\n  Basic ${Buffer.from("u:p").toString("base64")}`,
		`Proxy-Authorization: >-\n  Basic ${Buffer.from("p:w").toString("base64")}`,
		`Proxy-Authorization: &proxy-auth >-\n  Basic ${Buffer.from("p:w").toString("base64")}`,
		[
			"password: |-\n  example",
			`token: >-\n  ${"T".repeat(24)}`,
		].join("\n"),
		`password=${"P".repeat(12)}`,
		"postgres://test-user:example-only-password@db.example.test/app",
		`ghp_${"C".repeat(10)}\u200b${"C".repeat(10)}`,
		"alice@example.com",
	];
	for (const title of sensitiveTitles) {
		const f = fixture();
		await f.refresh(`set ${title}`);
		expect(f.state.title).toBe("existing task");
		expect(f.calls.filter((args) => args[0] === "rename-window")).toEqual([]);
		expect(f.requests).toHaveLength(0);
		expect(f.warnings).toEqual(["Sensitive-looking manual title was not applied."]);
		expect(f.warnings.join(" ")).not.toContain(title);
	}
});

test("rejecting a sensitive manual title leaves pending naming intact", async () => {
	const work = deferred();
	const f = fixture([work.promise]);
	f.input("Fix auth tests");
	await settle();
	const signal = f.requests[0].options.signal as AbortSignal;
	const token = ["ghp_", "D".repeat(20)].join("");
	await f.refresh(`set ${token}`);
	expect(signal.aborted).toBe(false);
	expect(f.state.title).toBe("existing task");
	expect(f.warnings).toEqual(["Sensitive-looking manual title was not applied."]);
	work.resolve(response("fix auth tests"));
	await settle();
	expect(f.state.title).toBe("fix auth tests");
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
	expect(f.calls).toEqual([["display-message", "-p", "-t", "%1", STATUS_SNAPSHOT_FORMAT]]);
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
	expect(f.calls.slice(previousCalls)).toEqual([["display-message", "-p", "-t", "%1", STATUS_SNAPSHOT_FORMAT]]);
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

test("status accepts a legacy adapter snapshot without server identity", async () => {
	const f = fixture();
	f.state.statusInfo = "$0\t@2\t0\t0\t0";
	await f.refresh("status");
	expect(f.notices.at(-1)).toContain("Targets: pane %1, window @2, session $0");
	expect(f.notices.at(-1)).toContain("tmux writes: enabled");
	expect(f.warnings).toEqual([]);
	expect(f.writes).toEqual([]);
});

test("status detects a changed server, cancels obsolete naming work, and leaves tmux untouched", async () => {
	const pending = deferred();
	const f = fixture([pending.promise]);
	f.state.windowInfo = "$0:1:123\t@2\t0\texisting task";
	f.input("synthetic task");
	await settle();
	expect(f.requests).toHaveLength(1);
	expect(f.requests[0].options.signal.aborted).toBe(false);

	f.state.statusInfo = "124\t$0\t@2\t0\t0\t0";
	const beforeWrites = [...f.writes];
	const beforeCalls = f.calls.length;
	await f.refresh("status");
	expect(f.notices.at(-1)).toContain("tmux writes: stopped (server changed; restart Pi to resume)");
	expect(f.notices.at(-1)).toContain("Naming request: idle");
	expect(f.requests[0].options.signal.aborted).toBe(true);
	expect(f.writes).toEqual(beforeWrites);
	expect(f.calls.slice(beforeCalls)).toEqual([[
		"display-message", "-p", "-t", "%1", STATUS_SNAPSHOT_FORMAT,
	]]);

	pending.resolve(response("obsolete title"));
	await settle();
	expect(f.state.title).toBe("existing task");
	expect(f.requests).toHaveLength(1);
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
	"123\t$0\t@2\t2\t0\t0", "123\t$0\t@2\t0\tx\t0", "123\t$0\t@2\t0\t0\t9",
	"pid\t$0\t@2\t0\t0\t0", "123\thome\t@2\t0\t0\t0", "123\t$0\t-t\t0\t0\t0",
	"123\t$0\t@2\t0\t0", "123\t$0\t@2\t0\t0\t0\textra",
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
		if (args[4] === STATUS_SNAPSHOT_FORMAT) { statusSignal = signal; await gate; }
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

test("a throwing warning notification does not poison later tmux updates", async () => {
	process.env.PI_TMUX_MODEL = "off";
	let failFirstLookup = true;
	const f = fixture([], async (args) => {
		if (failFirstLookup && args[0] === "display-message") {
			failFirstLookup = false;
			throw new Error("Synthetic tmux failure");
		}
	});
	let throwWarning = true;
	(f.ctx.ui as any).notify = (text: string, level: string) => {
		if (throwWarning && level === "warning") throw new Error("UI is disposed");
		(level === "warning" ? f.warnings : f.notices).push(text);
	};

	await f.emit("agent_settled");
	expect(f.state.waitingPanes.size).toBe(0);
	throwWarning = false;
	await f.refresh("sync");
	expect(f.state.waitingPanes.get("%1")).toBe("1");
	expect(f.state.title).toBe("* existing task");
	expect(f.notices).toContain("tmux title and waiting markers synchronized.");
});

test("a failed status notification is not misreported as a tmux failure", async () => {
	const f = fixture();
	let calls = 0;
	(f.ctx.ui as any).notify = (text: string, level: string) => {
		calls++;
		if (level === "info") throw new Error("UI is disposed");
		f.warnings.push(text);
	};

	await expect(f.refresh("status")).resolves.toBeUndefined();
	expect(calls).toBe(1);
	expect(f.warnings).toEqual([]);
	expect(f.calls).toHaveLength(1);
});

test("disposed UI notifications do not reject successful title commands", async () => {
	process.env.PI_TMUX_MODEL = "off";
	const f = fixture([]);
	(f.ctx.ui as any).notify = () => { throw new Error("UI is disposed"); };

	await expect(f.refresh("set pinned task")).resolves.toBeUndefined();
	expect(f.state.title).toBe("pinned task");
	await expect(f.refresh("sync")).resolves.toBeUndefined();
	await expect(f.refresh("status")).resolves.toBeUndefined();
	await expect(f.refresh("unknown command")).resolves.toBeUndefined();
	await expect(f.refresh("auto")).resolves.toBeUndefined();
});
