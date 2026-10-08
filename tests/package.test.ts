import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const manifestUrl = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));

test("the published Pi entrypoint imports without runtime SDK dependencies and runs its status-only lifecycle", async () => {
	const [entrypoint] = manifest.pi.extensions as string[];
	expect(entrypoint).toBe("./index.ts");
	expect(manifest.files).toContain(entrypoint.replace(/^\.\//, ""));

	const source = readFileSync(new URL(entrypoint, manifestUrl), "utf8");
	const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-package-"));
	const modulePath = join(directory, "index.mjs");
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	try {
		writeFileSync(modulePath, javascript);
		const extension = await import(pathToFileURL(modulePath).href);
		expect(typeof extension.default).toBe("function");
		expect(extension.MAX_TITLE_LENGTH).toBe(24);

		process.env.TMUX_PANE = "%1";
		process.env.PI_TMUX_MODEL = "off";
		const handlers = new Map<string, Function>();
		const calls: string[][] = [];
		const warnings: string[] = [];
		const tmux = async (args: string[]) => {
			calls.push(args);
			return args[0] === "display-message" ? "$1:1:42\t@2\t0\tcustom" : "";
		};
		extension.default({
			on: (event: string, handler: Function) => handlers.set(event, handler),
			registerCommand: () => {},
		}, tmux);
		expect([...handlers.keys()]).toEqual([
			"input", "agent_start", "agent_settled", "session_start", "session_tree", "session_compact", "session_shutdown",
		]);

		const context = {
			mode: "tui",
			get sessionManager() { throw new Error("Status-only lifecycle must not read session context"); },
			get modelRegistry() { throw new Error("Status-only lifecycle must not access models or credentials"); },
			ui: { notify: (text: string, level: string) => { if (level === "warning") warnings.push(text); } },
		};
		await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, context);
		await handlers.get("agent_settled")!({ type: "agent_settled" }, context);
		await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, context);
		expect(calls.filter((args) => args[0] === "set-option" && args.includes("@pi-tmux-waiting")).map((args) => args[12]))
			.toEqual(["0", "1", "0"]);
		expect(calls.some((args) => args[0] === "rename-window" && args[4].includes("zsh"))).toBe(true);
		expect(warnings).toEqual([]);
	} finally {
		if (originalPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalPane;
		if (originalModel === undefined) delete process.env.PI_TMUX_MODEL;
		else process.env.PI_TMUX_MODEL = originalModel;
		rmSync(directory, { recursive: true, force: true });
	}
});
