import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const COMMAND_TIMEOUT_MS = 30_000;

type CommandOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	maxBuffer?: number;
	shell?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
};

function needsCommandShell(file: string, platform = process.platform): boolean {
	// On Windows npm is a .cmd shim, which execFile cannot launch directly.
	return platform === "win32" && file === "npm";
}

function runCommand(file: string, args: string[], options: CommandOptions = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, {
			cwd: options.cwd,
			env: options.env,
			encoding: "utf8",
			maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
			shell: options.shell,
			timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
			killSignal: "SIGTERM",
			signal: options.signal,
		}, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

async function readPackedMember(archive: string, member: string): Promise<string> {
	return runCommand("tar", ["-xOzf", archive, member]);
}

test("only the Windows npm shim runs through a command shell", () => {
	expect(needsCommandShell("npm", "win32")).toBe(true);
	expect(needsCommandShell("npm", "linux")).toBe(false);
	expect(needsCommandShell("tar", "win32")).toBe(false);
});

test("package subprocesses are terminated on timeout and cancellation", async () => {
	const args = ["-e", "setInterval(() => {}, 1000)"];
	let timedOut: unknown;
	try {
		await runCommand(process.execPath, args, { timeoutMs: 50 });
	} catch (error) {
		timedOut = error;
	}
	expect(timedOut).toBeDefined();

	const controller = new AbortController();
	const cancelled = runCommand(process.execPath, args, { signal: controller.signal });
	controller.abort();
	let cancellation: unknown;
	try {
		await cancelled;
	} catch (error) {
		cancellation = error;
	}
	expect((cancellation as { name?: unknown } | undefined)?.name).toBe("AbortError");
});

test("the packed Pi entrypoint imports without runtime SDK dependencies and runs its status-only lifecycle", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-tmux-package-"));
	const originalPane = process.env.TMUX_PANE;
	const originalModel = process.env.PI_TMUX_MODEL;
	try {
		const repository = fileURLToPath(new URL("..", import.meta.url));
		const packedResults = JSON.parse(await runCommand("npm", ["pack", "--ignore-scripts", "--json"], {
			cwd: repository,
			env: { ...process.env, npm_config_pack_destination: directory },
			shell: needsCommandShell("npm"),
		})) as Array<{ filename?: unknown }>;
		const filename = packedResults[0]?.filename;
		if (typeof filename !== "string" || basename(filename) !== filename || !filename.endsWith(".tgz")) {
			throw new Error("npm pack returned an invalid archive filename");
		}
		const archive = join(directory, filename);
		const packageDirectory = join(directory, "package");
		mkdirSync(packageDirectory);

		const packedManifestPath = join(packageDirectory, "package.json");
		writeFileSync(packedManifestPath, await readPackedMember(archive, "package/package.json"));
		const manifest = JSON.parse(readFileSync(packedManifestPath, "utf8"));
		const entrypoints = manifest.pi?.extensions;
		const entrypoint: unknown = Array.isArray(entrypoints) ? entrypoints[0] : undefined;
		expect(entrypoint).toBe("./index.ts");
		if (entrypoint !== "./index.ts") throw new Error("Unexpected packed Pi entrypoint");
		expect(manifest.files).toContain(entrypoint.replace(/^\.\//, ""));
		expect(manifest.files).toContain("src/");
		expect(manifest.keywords).toContain("pi-extension");
		expect(manifest.keywords).toContain("coding-agent");
		expect(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("^1.1.0");

		// Extract only expected, fixed module paths rather than allowing archive
		// members or manifest paths to escape this temporary directory.
		const runtimeFiles = [
			"index.ts",
			"src/title.ts",
			"src/naming.ts",
			"src/tmux.ts",
			"src/controller.ts",
			"src/extension.ts",
		];
		for (const member of runtimeFiles) {
			const packedPath = join(packageDirectory, member);
			mkdirSync(dirname(packedPath), { recursive: true });
			writeFileSync(packedPath, await readPackedMember(archive, `package/${member}`));
		}
		const packedEntrypoint = join(packageDirectory, "index.ts");
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
