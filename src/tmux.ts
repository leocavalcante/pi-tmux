import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatTitle, READY_PREFIX } from "./title.ts";

const execFileAsync = promisify(execFile);
// WINDOW_INFO_FORMAT includes a user-owned window name; allow long names while
// keeping command output bounded.
const MAX_TMUX_OUTPUT_BYTES = 64 * 1024;

export const WAITING_OPTION = "@pi-tmux-waiting";
export const ACTIVE_OPTION = "@pi-tmux-active";
// Normalize each pane option before aggregation; matching raw values such as 10
// would otherwise mistake any embedded `1` for a true flag.
const WAITING_FLAG_FORMAT = `#{?#{==:#{${WAITING_OPTION}},1},1,0}`;
const ACTIVE_OR_WAITING_FLAG_FORMAT = `#{?#{==:#{${ACTIVE_OPTION}},1},1,${WAITING_FLAG_FORMAT}}`;
// tmux evaluates this on the server after the pane status write, so concurrent
// Pi instances aggregate their status without a client-side read/rename race.
export const SESSION_WAITING_FORMAT = `#{m:*1*,#{W:#{P:${WAITING_FLAG_FORMAT}}}}`;
// Preserve the original format for RunTmux adapters that return legacy target
// fields; capable tmux servers use the stored-base format below.
export const SESSION_TITLE_FORMAT =
	`#{?${SESSION_WAITING_FORMAT},${READY_PREFIX},}#{s/^\\* //:session_name}`;
export const SESSION_BASE_NAME_OPTION = "@pi-tmux-session-base-name";
export const SESSION_TITLE_MARKED_OPTION = "@pi-tmux-session-title-marked";
const SESSION_BASE_NAME_VALUE_FORMAT = `#{${SESSION_BASE_NAME_OPTION}}`;
// Nested tmux format expansion doubles literal backslashes in names. Decode
// only those nested values; direct values stay untouched.
const unescapeNestedTmuxFormatValue = (format: string) => String.raw`#{s/\\\\/\\/g:${format}}`;
const SESSION_NAME_IS_BASE_FORMAT = `#{==:${unescapeNestedTmuxFormatValue("#{session_name}")},${SESSION_BASE_NAME_VALUE_FORMAT}}`;
const SESSION_NAME_IS_MARKED_BASE_FORMAT =
	`#{==:${unescapeNestedTmuxFormatValue("#{session_name}")},${READY_PREFIX}${SESSION_BASE_NAME_VALUE_FORMAT}}`;
// The transitional state lets concurrent Pi updates safely overlap the rename.
// The steady state also detects user renames that happen to begin with `* `.
const SESSION_NAME_LITERAL_FORMAT = unescapeNestedTmuxFormatValue("#{session_name}");
export const SESSION_BASE_NAME_UPDATE_FORMAT =
	`#{?#{==:#{${SESSION_TITLE_MARKED_OPTION}},transition},#{?${SESSION_NAME_IS_BASE_FORMAT},${SESSION_BASE_NAME_VALUE_FORMAT},#{?${SESSION_NAME_IS_MARKED_BASE_FORMAT},${SESSION_BASE_NAME_VALUE_FORMAT},${SESSION_NAME_LITERAL_FORMAT}}},#{?#{==:#{${SESSION_TITLE_MARKED_OPTION}},marked},#{?${SESSION_NAME_IS_MARKED_BASE_FORMAT},${SESSION_BASE_NAME_VALUE_FORMAT},${SESSION_NAME_LITERAL_FORMAT}},#{?${SESSION_NAME_IS_BASE_FORMAT},${SESSION_BASE_NAME_VALUE_FORMAT},${SESSION_NAME_LITERAL_FORMAT}}}}`;
export const SESSION_BASE_NAME_TITLE_FORMAT =
	`#{?${SESSION_WAITING_FORMAT},${READY_PREFIX}${SESSION_BASE_NAME_VALUE_FORMAT},${SESSION_BASE_NAME_VALUE_FORMAT}}`;
export const SESSION_TITLE_MARKED_VALUE_FORMAT =
	`#{?${SESSION_NAME_IS_MARKED_BASE_FORMAT},marked,unmarked}`;
export const WINDOW_WAITING_FORMAT = `#{m:*1*,#{P:${WAITING_FLAG_FORMAT}}}`;
// Waiting flags also recognize idle peers loaded before active tracking existed.
export const WINDOW_ACTIVE_FORMAT = `#{m:*1*,#{P:${ACTIVE_OR_WAITING_FLAG_FORMAT}}}`;
export const WINDOW_BASE_NAME_OPTION = "@pi-tmux-window-base-name";
export const WINDOW_TITLE_MARKED_OPTION = "@pi-tmux-window-title-marked";
export const WINDOW_TITLE_LITERAL_PREFIX_OPTION = "@pi-tmux-window-literal-prefix";
const WINDOW_BASE_NAME_VALUE_FORMAT = `#{${WINDOW_BASE_NAME_OPTION}}`;
const WINDOW_NAME_IS_BASE_FORMAT = `#{==:${unescapeNestedTmuxFormatValue("#{window_name}")},${WINDOW_BASE_NAME_VALUE_FORMAT}}`;
const WINDOW_BASE_NAME_MARKED_TITLE_FORMAT =
	`#{?#{==:${WINDOW_BASE_NAME_VALUE_FORMAT},},${READY_PREFIX}pi,${READY_PREFIX}${WINDOW_BASE_NAME_VALUE_FORMAT}}`;
const WINDOW_NAME_IS_MARKED_BASE_FORMAT =
	`#{==:${unescapeNestedTmuxFormatValue("#{window_name}")},${WINDOW_BASE_NAME_MARKED_TITLE_FORMAT}}`;
const WINDOW_NAME_LITERAL_FORMAT = unescapeNestedTmuxFormatValue("#{window_name}");
// Track an unmarked base independently so a literal leading `* ` survives
// aggregate waiting prefixes, including overlapping updates from shared panes.
export const WINDOW_BASE_NAME_UPDATE_FORMAT =
	`#{?#{==:#{${WINDOW_TITLE_MARKED_OPTION}},transition},#{?${WINDOW_NAME_IS_BASE_FORMAT},${WINDOW_BASE_NAME_VALUE_FORMAT},#{?${WINDOW_NAME_IS_MARKED_BASE_FORMAT},${WINDOW_BASE_NAME_VALUE_FORMAT},${WINDOW_NAME_LITERAL_FORMAT}}},#{?#{==:#{${WINDOW_TITLE_MARKED_OPTION}},marked},#{?${WINDOW_NAME_IS_MARKED_BASE_FORMAT},${WINDOW_BASE_NAME_VALUE_FORMAT},${WINDOW_NAME_LITERAL_FORMAT}},#{?${WINDOW_NAME_IS_BASE_FORMAT},${WINDOW_BASE_NAME_VALUE_FORMAT},${WINDOW_NAME_LITERAL_FORMAT}}}}`;
export const WINDOW_BASE_NAME_TITLE_FORMAT =
	`#{?${WINDOW_WAITING_FORMAT},${READY_PREFIX}#{?#{==:${WINDOW_BASE_NAME_VALUE_FORMAT},},pi,${WINDOW_BASE_NAME_VALUE_FORMAT}},${WINDOW_BASE_NAME_VALUE_FORMAT}}`;
export const WINDOW_TITLE_MARKED_VALUE_FORMAT = `#{?${WINDOW_NAME_IS_MARKED_BASE_FORMAT},marked,unmarked}`;
export const WINDOW_BASE_NAME_HAS_LITERAL_PREFIX_FORMAT =
	`#{?#{==:#{s/^\\* //:${WINDOW_BASE_NAME_VALUE_FORMAT}},${WINDOW_BASE_NAME_VALUE_FORMAT}},0,1}`;
// The fixed suffix advertises session-name base-option support; the PID scopes
// numeric tmux IDs to the server process that produced this snapshot.
export const WINDOW_INFO_FORMAT = `#{session_id}:1:#{pid}\t#{window_id}\t#{?${WINDOW_WAITING_FORMAT},1,0}\t#{window_name}`;
// Diagnostics omit names and dialogue, reading all flags in one server snapshot.
export const STATUS_INFO_FORMAT = `#{session_id}\t#{window_id}\t${WAITING_FLAG_FORMAT}\t#{?${WINDOW_WAITING_FORMAT},1,0}\t#{?${SESSION_WAITING_FORMAT},1,0}`;
// Keep the public status format stable while including identity in the controller's private snapshot.
export const STATUS_SNAPSHOT_FORMAT = `#{pid}\t${STATUS_INFO_FORMAT}`;
const CURRENT_TASK_FORMAT = "#{s/^\\* //:window_name}";
export const SHARED_TASK_TITLE_FORMAT = `#{?${WINDOW_WAITING_FORMAT},${READY_PREFIX}#{=22:${CURRENT_TASK_FORMAT}},${CURRENT_TASK_FORMAT}}`;
// Former-window and quit cleanup preserve the current name; unlike shared
// task-title updates, cleanup must not truncate a long custom title.
export const SHARED_WINDOW_TITLE_FORMAT = `#{?${WINDOW_WAITING_FORMAT},${READY_PREFIX}${CURRENT_TASK_FORMAT},${CURRENT_TASK_FORMAT}}`;
// If no task title exists, toggle only the waiting prefix around the literal
// current window name instead of normalizing or clipping user-owned text.
export const PRESERVED_WINDOW_TITLE_FORMAT =
	`#{?${WINDOW_WAITING_FORMAT},${READY_PREFIX},}${unescapeNestedTmuxFormatValue(CURRENT_TASK_FORMAT)}`;
export const WINDOW_REPAIR_NEEDED_FORMAT = `#{!=:#{window_name},${SHARED_WINDOW_TITLE_FORMAT}}`;
// Both branches contain only sanitized title text. tmux chooses the prefix at
// execution time, so another pane's status cannot be lost during a slow rename.
export function buildWindowTitleFormat(title: string): string {
	return `#{?${WINDOW_WAITING_FORMAT},${formatTitle(title, true)},${formatTitle(title, false)}}`;
}

export function buildWindowBaseTitleUpdateArgs(
	target: string,
	baseName: string,
	baseNameIsFormat = false,
	titleFormat = WINDOW_BASE_NAME_TITLE_FORMAT,
): string[] {
	return [
		"set-option", ...(baseNameIsFormat ? ["-F"] : []), "-w", "-t", target, WINDOW_BASE_NAME_OPTION, baseName,
		";", "set-option", "-F", "-w", "-t", target, WINDOW_TITLE_LITERAL_PREFIX_OPTION, WINDOW_BASE_NAME_HAS_LITERAL_PREFIX_FORMAT,
		";", "set-option", "-w", "-t", target, WINDOW_TITLE_MARKED_OPTION, "transition",
		";", "if-shell", "-F", "-t", target, `#{!=:#{window_name},${titleFormat}}`,
		`rename-window -t ${target} -- '${titleFormat}'`,
		";", "set-option", "-F", "-w", "-t", target, WINDOW_TITLE_MARKED_OPTION, WINDOW_TITLE_MARKED_VALUE_FORMAT,
	];
}

export function buildWindowBaseQuitTitleFormats(idleTitle: string) {
	return {
		baseName: `#{?${WINDOW_ACTIVE_FORMAT},${WINDOW_BASE_NAME_UPDATE_FORMAT},${idleTitle}}`,
		title: `#{?${WINDOW_ACTIVE_FORMAT},${WINDOW_BASE_NAME_TITLE_FORMAT},${buildWindowTitleFormat(idleTitle)}}`,
	};
}

// A sibling may start, quit, or rename the window after our last lookup. Decide
// ownership at execution time and preserve its latest title, not our snapshot.
export function buildQuitTitleFormat(idleTitle: string): string {
	return `#{?${WINDOW_ACTIVE_FORMAT},${SHARED_WINDOW_TITLE_FORMAT},${buildWindowTitleFormat(idleTitle)}}`;
}
export const QUIT_TITLE_FORMAT = buildQuitTitleFormat("zsh");

export type RunTmux = ((args: string[], signal: AbortSignal) => Promise<string>) & {
	// Adapters can opt into receiving the built-in server-PID if-shell wrapper.
	supportsServerPidGuard?: boolean;
};

export const runTmux: RunTmux = async (args, signal) => {
	const { stdout } = await execFileAsync("tmux", args, {
		signal,
		timeout: 2_000,
		maxBuffer: MAX_TMUX_OUTPUT_BYTES,
	});
	// Remove the command's line terminator, not tabs or spaces in window names.
	// In particular, a trailing tab is the empty title field in WINDOW_INFO_FORMAT.
	return stdout.replace(/\r?\n$/, "");
};
runTmux.supportsServerPidGuard = true;

// if-shell compares the server PID and executes the complete write batch only
// on the server that supplied the preceding lookup. A client-side check alone
// cannot protect reused numeric targets if tmux restarts before the next call.
function quoteTmuxCommandArgument(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tmuxCommandString(args: string[]): string {
	return args.map((value) => value === ";" ? ";" : quoteTmuxCommandArgument(value)).join(" ");
}

export type WindowSnapshot = {
	session: string;
	window: string;
	title: string;
	waiting: boolean;
	sessionMetadataAvailable: boolean;
	server?: string;
};

export async function readWindowTitle(tmux: RunTmux, target: string, signal: AbortSignal): Promise<WindowSnapshot> {
	const info = await tmux(["display-message", "-p", "-t", target, WINDOW_INFO_FORMAT], signal);
	const [sessionField, window, windowWaiting, ...titleParts] = info.split("\t");
	// Keep an empty PID valid for older tmux servers and injected adapters.
	const sessionMetadata = /^(\$\d+):1(?::(\d*))?$/.exec(sessionField);
	const legacySession = /^(\$\d+)$/.exec(sessionField);
	const session = sessionMetadata?.[1] ?? legacySession?.[1];
	if (!session || !/^@\d+$/.test(window) || !/^[01]$/.test(windowWaiting) || !titleParts.length) {
		throw new Error("Invalid tmux target");
	}
	return {
		session, window, title: titleParts.join("\t"), waiting: windowWaiting === "1",
		sessionMetadataAvailable: sessionMetadata !== null,
		server: sessionMetadata?.[2] || undefined,
	};
}

export async function readWindowTitleMark(tmux: RunTmux, target: string, signal: AbortSignal): Promise<string | undefined> {
	const value = await tmux(["show-options", "-w", "-qv", "-t", target, WINDOW_TITLE_MARKED_OPTION], signal);
	return ["marked", "unmarked", "transition"].includes(value) ? value : undefined;
}

export async function hasWindowLiteralPrefix(tmux: RunTmux, target: string, signal: AbortSignal): Promise<boolean> {
	return await tmux(["show-options", "-w", "-qv", "-t", target, WINDOW_TITLE_LITERAL_PREFIX_OPTION], signal) === "1";
}

export function writeOnServer(tmux: RunTmux, server: string | undefined, args: string[], signal: AbortSignal) {
	if (!server || !tmux.supportsServerPidGuard) return tmux(args, signal);
	return tmux(["if-shell", "-F", `#{==:#{pid},${server}}`, tmuxCommandString(args)], signal);
}

export function targetDisappeared(error: unknown, target: string) {
	const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : undefined;
	const message = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : typeof stderr === "string" ? stderr : "";
	return message.trim() === `can't find ${target.startsWith("@") ? "window" : "session"}: ${target}`;
}
