import { expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childHasExited, waitForChild } from "./tmux-test-utils.ts";

const COMMAND_TIMEOUT_MS = 30_000;
const PUBLIC_RUNTIME_EXPORTS = [
	"ACTIVE_OPTION",
	"MAX_CONTEXT_LENGTH",
	"MAX_HISTORY_MESSAGES",
	"MAX_PROMPT_LENGTH",
	"MAX_TITLE_LENGTH",
	"QUIT_TITLE_FORMAT",
	"READY_PREFIX",
	"SESSION_TITLE_FORMAT",
	"SESSION_WAITING_FORMAT",
	"STATUS_INFO_FORMAT",
	"WAITING_OPTION",
	"WINDOW_ACTIVE_FORMAT",
	"WINDOW_INFO_FORMAT",
	"WINDOW_WAITING_FORMAT",
	"buildNamingContext",
	"buildWindowTitleFormat",
	"cleanTitle",
	"default",
	"formatTitle",
	"parseNamingModel",
].sort();

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
			// These are disposable test subprocesses; don't leave a child alive when it handles SIGTERM.
			killSignal: "SIGKILL",
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

function cleanupPackageDirectory(directory: string, remove: (path: string) => void = (path) => {
	rmSync(path, { recursive: true, force: true });
}): void {
	try { remove(directory); } catch { /* Cleanup must not mask a packaging or assertion failure. */ }
}

test("only the Windows npm shim runs through a command shell", () => {
	expect(needsCommandShell("npm", "win32")).toBe(true);
	expect(needsCommandShell("npm", "linux")).toBe(false);
	expect(needsCommandShell("tar", "win32")).toBe(false);
});

test("package fixture cleanup does not mask the original failure", () => {
	const failure = new Error("package test failed");
	let observed: unknown;
	try {
		try {
			throw failure;
		} finally {
			cleanupPackageDirectory("fixture", () => { throw new Error("cleanup failed"); });
		}
	} catch (error) {
		observed = error;
	}
	expect(observed).toBe(failure);
});

test("package subprocesses are force-killed on timeout and cancellation", async () => {
	const nodeExecutable = Bun.which("node");
	if (!nodeExecutable) throw new Error("Node.js is required for subprocess cancellation coverage");
	const runStubbornChild = async (options: CommandOptions, abort?: () => void, errorName?: string) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-tmux-package-child-"));
		const pidFile = join(directory, "pid");
		const args = ["-e", [
			"process.on('SIGTERM', () => {});",
			`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
			"setInterval(() => {}, 1000);",
		].join(" ")];
		let pid: number | undefined;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		try {
			const commandOutcome = runCommand(nodeExecutable, args, options).then(
				() => ({ settled: true as const, error: undefined }),
				(error: unknown) => ({ settled: true as const, error }),
			);
			pid = await waitForChild(pidFile);
			abort?.();
			const result = await Promise.race([
				commandOutcome,
				new Promise<{ settled: false }>((resolve) => {
					watchdog = setTimeout(() => resolve({ settled: false }), 4_000);
				}),
			]);
			if (watchdog) clearTimeout(watchdog);
			if (!result.settled) {
				try { process.kill(pid, "SIGKILL"); } catch { /* The child may exit as the watchdog fires. */ }
				await commandOutcome;
			}
			expect(result.settled).toBe(true);
			if (result.settled) {
				expect(result.error).toBeDefined();
				if (errorName) expect(result.error).toMatchObject({ name: errorName });
			}
			expect(await childHasExited(pid)).toBe(true);
		} finally {
			if (watchdog) clearTimeout(watchdog);
			if (pid) {
				try { process.kill(pid, "SIGKILL"); } catch { /* The child may already be gone. */ }
			}
			cleanupPackageDirectory(directory);
		}
	};

	const controller = new AbortController();
	await runStubbornChild({ timeoutMs: 2_500 }, undefined, "Error");
	await runStubbornChild({ signal: controller.signal }, () => controller.abort(), "AbortError");
}, 15_000);

// Packing, installing in Pi, and importing the entrypoint can exceed Bun's default timeout on slower CI runners.
test("the packed Pi extension installs through the CLI and runs its status-only lifecycle", async () => {
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
		expect(manifest.repository).toEqual({ type: "git", url: "git+https://github.com/leocavalcante/pi-tmux.git" });
		expect(manifest.files).toContain(entrypoint.replace(/^\.\//, ""));
		expect(manifest.files).toContain("src/");
		expect(manifest.keywords).toContain("pi-extension");
		expect(manifest.keywords).toContain("coding-agent");
		expect(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("^1.1.0");
		const packedReadme = await readPackedMember(archive, "package/README.md");
		expect(packedReadme).toContain("The npm package is available:");
		expect(packedReadme).toContain("pi install npm:@leocavalcante/pi-tmux");
		expect(packedReadme).not.toContain("The npm package has not been published yet");

		// Extract only expected, fixed module paths rather than allowing archive
		// members or manifest paths to escape this temporary directory.
		const runtimeFiles = [
			"index.ts",
			"src/title.ts",
			"src/naming.ts",
			"src/unicode-digits.ts",
			"src/tmux.ts",
			"src/controller.ts",
			"src/extension.ts",
			"src/notify.ts",
		];
		for (const member of runtimeFiles) {
			const packedPath = join(packageDirectory, member);
			mkdirSync(dirname(packedPath), { recursive: true });
			writeFileSync(packedPath, await readPackedMember(archive, `package/${member}`));
		}
		const packedEntrypoint = join(packageDirectory, "index.ts");
		const piSdkDirectory = join(repository, "node_modules", "@earendil-works", "pi-coding-agent");
		const piManifest = JSON.parse(readFileSync(join(piSdkDirectory, "package.json"), "utf8")) as {
			bin?: string | Record<string, string>;
		};
		const piBin = typeof piManifest.bin === "string" ? piManifest.bin : piManifest.bin?.pi;
		if (!piBin) throw new Error("The Pi SDK package does not expose its CLI entrypoint");
		const homeDirectory = join(directory, "home");
		const projectDirectory = join(directory, "project");
		mkdirSync(homeDirectory);
		mkdirSync(projectDirectory);
		const piEnvironment: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			HOME: homeDirectory,
			USERPROFILE: homeDirectory,
			TMPDIR: directory,
			TEMP: directory,
			TMP: directory,
			TERM: "dumb",
			PI_OFFLINE: "1",
			XDG_CONFIG_HOME: join(homeDirectory, ".config"),
			XDG_CACHE_HOME: join(homeDirectory, ".cache"),
			XDG_DATA_HOME: join(homeDirectory, ".local", "share"),
		};
		if (process.platform === "win32") {
			for (const key of ["SystemRoot", "WINDIR", "ComSpec", "SystemDrive"] as const) {
				const value = process.env[key];
				if (value) piEnvironment[key] = value;
			}
			piEnvironment.APPDATA = join(homeDirectory, "AppData", "Roaming");
			piEnvironment.LOCALAPPDATA = join(homeDirectory, "AppData", "Local");
		}
		execFileSync(process.execPath, [
			join(piSdkDirectory, piBin),
			"install",
			packageDirectory,
			"--local",
			"--approve",
		], {
			cwd: projectDirectory,
			env: piEnvironment,
			encoding: "utf8",
			timeout: COMMAND_TIMEOUT_MS,
		});
		const piOutput = execFileSync(process.execPath, [
			join(piSdkDirectory, piBin),
			"--approve",
			"--mode", "rpc",
			"--no-session",
			"--no-mcp",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-tools",
			"--offline",
		], {
			cwd: projectDirectory,
			env: piEnvironment,
			encoding: "utf8",
			input: '{"id":"package-smoke","type":"get_commands"}\n',
			timeout: COMMAND_TIMEOUT_MS,
		});
		type RpcRecord = {
			type?: unknown;
			id?: unknown;
			command?: unknown;
			success?: unknown;
			data?: { commands?: Array<{ name?: unknown }> };
		};
		const rpcRecords = piOutput.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as RpcRecord);
		const commandResponse = rpcRecords.find((record) =>
			record.type === "response" && record.command === "get_commands" && record.id === "package-smoke");
		expect(commandResponse?.success).toBe(true);
		expect(commandResponse?.data?.commands?.map((command) => command.name)).toContain("tmux-title");

		const source = readFileSync(packedEntrypoint, "utf8");
		const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
		const modulePath = join(packageDirectory, "index.mjs");
		writeFileSync(modulePath, javascript);
		const extension = await import(pathToFileURL(modulePath).href);
		expect(Object.keys(extension).sort()).toEqual(PUBLIC_RUNTIME_EXPORTS);
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
		cleanupPackageDirectory(directory);
	}
}, 30_000);
