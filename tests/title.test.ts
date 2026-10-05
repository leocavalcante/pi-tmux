import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piTmux, { cleanTitle, MAX_PROMPT_LENGTH, MAX_TITLE_LENGTH, type RunTmux } from "../index";

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

function fixture(results: Promise<ReturnType<typeof response>>[] = [Promise.resolve(response("Fix auth tests"))]) {
	const handlers = new Map<string, Function>();
	const calls: string[][] = [];
	const requests: { model: unknown; context: any; options: any }[] = [];
	const warnings: string[] = [];
	const ctx = {
		mode: "tui",
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
	const tmux: RunTmux = async (args) => {
		calls.push(args);
		return args[0] === "display-message" ? "@2" : "";
	};
	piTmux({ on: (event: string, handler: Function) => handlers.set(event, handler) } as unknown as ExtensionAPI, tmux);
	const input = (text: string, source = "interactive") => handlers.get("input")!({ text, source }, ctx);
	return { handlers, calls, requests, warnings, ctx, input };
}

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
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
	expect(f.calls).toEqual([
		["display-message", "-p", "-t", "%1", "#{window_id}"],
		["rename-window", "-t", "@2", "fix auth tests"],
	]);
	expect(f.warnings).toEqual([]);
});

test("bounds prompt and output, disables reasoning and retries, sends no transcript", async () => {
	const f = fixture();
	f.input("x".repeat(10_000));
	await settle();
	const request = f.requests[0];
	expect(request.context.messages).toHaveLength(1);
	expect(request.context.messages[0].content).toHaveLength(MAX_PROMPT_LENGTH);
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
		f.handlers.get(event)!();
		expect(f.requests[0].options.signal.aborted).toBe(true);
		work.resolve(response("Late title"));
		await settle();
		expect(f.calls).toEqual([]);
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
	expect(f.calls).toEqual([]);
	expect(f.warnings).toHaveLength(1);
});

test("empty or failed responses never become window names", async () => {
	for (const result of [response(""), response("---"), response("Error details", "error")]) {
		const f = fixture([Promise.resolve(result)]);
		f.input("Task");
		await settle();
		expect(f.calls).toEqual([]);
		expect(f.warnings).toHaveLength(1);
	}
});
