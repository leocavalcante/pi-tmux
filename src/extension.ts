import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createController } from "./controller.ts";
import { hasSensitiveOutput } from "./naming.ts";
import { notifySafely } from "./notify.ts";
import { cleanTitle, MAX_TITLE_INPUT_LENGTH } from "./title.ts";
import { runTmux, type RunTmux } from "./tmux.ts";

const HAS_NON_WHITESPACE = /[^\s\p{White_Space}]/u;
// Bound trimming and regex captures, leaving room for the command and whitespace.
const MAX_TITLE_COMMAND_ARGUMENT_LENGTH = MAX_TITLE_INPUT_LENGTH * 2;
const QUIT_PANE_WAIT_ATTEMPTS = 300;

export function buildQuitPaneWatcherCommand(pane: string, processId: number, serverPid: string): string {
	if (!/^%\d+$/.test(pane) || !Number.isSafeInteger(processId) || processId <= 0 || !/^\d+$/.test(serverPid)) {
		throw new Error("Invalid tmux pane identity");
	}
	// run-shell expands formats once; double # so its shell passes #{pid} to display-message.
	return [
		`pi_pid=${processId}`,
		`pane='${pane}'`,
		`server_pid='${serverPid}'`,
		"attempt=0",
		`while kill -0 "$pi_pid" 2>/dev/null; do if [ "$attempt" -ge ${QUIT_PANE_WAIT_ATTEMPTS} ]; then exit 0; fi; attempt=$((attempt + 1)); sleep 0.1; done`,
		`current_server=$(tmux display-message -p -t "$pane" '##{pid}' 2>/dev/null) || exit 0`,
		`[ "$current_server" = "$server_pid" ] || exit 0`,
		`tmux kill-pane -t "$pane"`,
	].join("; ");
}

export default function piTmux(pi: ExtensionAPI, tmux: RunTmux = runTmux) {
	const controller = createController(tmux);

	pi.registerCommand("tmux-title", {
		description: "Refresh, pin with set <name>, resume with auto, inspect status, or sync without AI",
		getArgumentCompletions: (prefix) => {
			if (prefix.length > MAX_TITLE_COMMAND_ARGUMENT_LENGTH) return null;
			const token = prefix.trimStart();
			// Complete only the subcommand, never free-form title text or extra args.
			if (/\s/.test(token)) return null;
			const items = [
				{ value: "status", label: "status", description: "Show read-only title diagnostics" },
				{ value: "sync", label: "sync", description: "Reapply titles and markers without AI" },
				{ value: "set ", label: "set <name>", description: "Pin a manual title" },
				{ value: "auto", label: "auto", description: "Resume automatic naming" },
			].filter((item) => item.value.startsWith(token));
			// Exact complete commands should submit on Enter, not re-accept themselves.
			if (items.some((item) => item.value === token)) return null;
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (args.length > MAX_TITLE_COMMAND_ARGUMENT_LENGTH) {
				notifySafely(ctx, "Title command input is too long to process safely; it was not applied.", "warning");
				return;
			}
			const command = args.trim();
			const set = /^set(?:\s+([\s\S]*))?$/.exec(command);
			if (command && !["auto", "status", "sync"].includes(command) && !set) {
				notifySafely(ctx, "Usage: /tmux-title [set <name> | auto | status | sync]", "warning");
				return;
			}
			const pane = controller.getPane(ctx);
			if (!pane) {
				notifySafely(ctx, "Title commands require interactive Pi inside tmux.", "warning");
				return;
			}
			if (command === "status") {
				await controller.status(ctx, pane);
				return;
			}
			if (command === "sync") {
				await controller.sync(ctx, pane);
				return;
			}
			if (set) {
				const requestedTitle = set[1] ?? "";
				if (requestedTitle.length > MAX_TITLE_INPUT_LENGTH) {
					notifySafely(ctx, "Manual title input is too long to check safely; it was not applied.", "warning");
					return;
				}
				if (hasSensitiveOutput(requestedTitle)) {
					notifySafely(ctx, "Sensitive-looking manual title was not applied.", "warning");
					return;
				}
				const title = cleanTitle(requestedTitle);
				if (!title) {
					notifySafely(ctx, "Provide a title containing letters or numbers: /tmux-title set <name>", "warning");
					return;
				}
				await controller.pinTitle(ctx, pane, title);
				return;
			}
			if (command === "auto") controller.resumeAutomaticNaming();
			controller.refresh(ctx);
		},
	});

	pi.registerCommand("quit-pane", {
		description: "Quit Pi and close the current tmux pane",
		handler: async (_args, ctx) => {
			const pane = controller.getPane(ctx);
			if (!pane) {
				notifySafely(ctx, "This command requires interactive Pi inside tmux.", "warning");
				return;
			}
			try {
				const signal = new AbortController().signal;
				const serverPid = await tmux(["display-message", "-p", "-t", pane, "#{pid}"], signal);
				if (!/^\d+$/.test(serverPid)) throw new Error("Invalid tmux server identity");
				await tmux(["run-shell", "-b", buildQuitPaneWatcherCommand(pane, process.pid, serverPid)], signal);
			} catch {
				notifySafely(ctx, "Could not prepare to close the current tmux pane; Pi is still running.", "warning");
				return;
			}
			ctx.shutdown();
		},
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" || !controller.getPane(ctx) || !HAS_NON_WHITESPACE.test(event.text)) return { action: "continue" };
		void controller.setWaiting(ctx, false);
		controller.requestTitle(ctx, event.text, false, true);
		return { action: "continue" };
	});

	pi.on("agent_start", (_event, ctx) => { void controller.setWaiting(ctx, false); });
	// agent_end/turn_end can precede retries, tool work, or queued continuations.
	pi.on("agent_settled", (_event, ctx) => {
		const status = controller.setWaiting(ctx, true);
		controller.requestTitle(ctx, "", false, true);
		return status;
	});
	pi.on("session_start", (_event, ctx) => controller.restoreTitle(ctx));
	// Tree navigation changes the active branch, not whether the agent is waiting.
	pi.on("session_tree", (_event, ctx) => controller.restoreTitle(ctx, true));
	pi.on("session_before_compact", (_event, ctx) => controller.setCompacting(ctx, true));
	pi.on("session_compact", (_event, ctx) => {
		const status = controller.setCompacting(ctx, false);
		controller.requestTitle(ctx, "", false, true);
		return status;
	});
	pi.on("session_compact_failed", (_event, ctx) => controller.setCompacting(ctx, false));
	// Reload and session replacement tear down extensions without exiting Pi.
	pi.on("session_shutdown", (event, ctx) => controller.reset(ctx, undefined, event.reason !== "quit"));
}
