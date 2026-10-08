import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function readPackedMember(archive: string, member: string): string {
	return execFileSync("tar", ["-xOzf", archive, member], {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
}

test("the packed Pi entrypoint imports without runtime SDK dependencies and runs its status-only lifecycle", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-package-"));
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	try {
		const repository = fileURLToPath(new URL("..", import.meta.url));
		const packedResults = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
			cwd: repository,
			encoding: "utf8",
		})) as Array<{ filename?: unknown }>;
		const filename = packedResults[0]?.filename;
		if (typeof filename !== "string" || basename(filename) !== filename || !filename.endsWith(".tgz")) {
			throw new Error("npm pack returned an invalid archive filename");
		}
		const archive = join(directory, filename);
		const packageDirectory = join(directory, "package");
		mkdirSync(packageDirectory);

		const packedManifestPath = join(packageDirectory, "package.json");
		writeFileSync(packedManifestPath, readPackedMember(archive, "package/package.json"));
		const manifest = JSON.parse(readFileSync(packedManifestPath, "utf8"));
		const entrypoints = manifest.pi?.extensions;
		const entrypoint: unknown = Array.isArray(entrypoints) ? entrypoints[0] : undefined;
		expect(entrypoint).toBe("./index.ts");
		if (entrypoint !== "./index.ts") throw new Error("Unexpected packed Pi entrypoint");
		expect(manifest.files).toContain(entrypoint.replace(/^\.\//, ""));

		// Use the fixed, validated package path instead of allowing a manifest path
		// to direct archive extraction outside this temporary directory.
		const packedEntrypoint = join(packageDirectory, "index.ts");
		writeFileSync(packedEntrypoint, readPackedMember(archive, "package/index.ts"));
		const source = readFileSync(packedEntrypoint, "utf8");
		const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
		const modulePath = join(packageDirectory, "index.mjs");
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
