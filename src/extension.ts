import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createController } from "./controller.ts";
import { cleanTitle } from "./title.ts";
import { runTmux, type RunTmux } from "./tmux.ts";

const HAS_NON_WHITESPACE = /[^\s\p{White_Space}]/u;

export default function piTmux(pi: ExtensionAPI, tmux: RunTmux = runTmux) {
	const controller = createController(tmux);

	pi.registerCommand("tmux-title", {
		description: "Refresh, pin with set <name>, resume with auto, inspect status, or sync without AI",
		getArgumentCompletions: (prefix) => {
			const token = prefix.trimStart();
			// Complete only the subcommand, never free-form title text or extra args.
			if (/\s/.test(token)) return null;
			const items = [
				{ value: "status", label: "status", description: "Show read-only title diagnostics" },
				{ value: "sync", label: "sync", description: "Reapply titles and markers without AI" },
				{ value: "set ", label: "set <name>", description: "Pin a manual title" },
				{ value: "auto", label: "auto", description: "Resume automatic naming" },
			].filter((item) => item.value.startsWith(token));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim();
			const set = /^set(?:\s+([\s\S]*))?$/.exec(command);
			if (command && !["auto", "status", "sync"].includes(command) && !set) {
				ctx.ui.notify("Usage: /tmux-title [set <name> | auto | status | sync]", "warning");
				return;
			}
			const pane = controller.getPane(ctx);
			if (!pane) {
				ctx.ui.notify("Title commands require interactive Pi inside tmux.", "warning");
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
				const title = cleanTitle(set[1] ?? "");
				if (!title) {
					ctx.ui.notify("Provide a title containing letters or numbers: /tmux-title set <name>", "warning");
					return;
				}
				await controller.pinTitle(ctx, pane, title);
				return;
			}
			if (command === "auto") controller.resumeAutomaticNaming();
			controller.refresh(ctx);
		},
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" || !controller.getPane(ctx) || !HAS_NON_WHITESPACE.test(event.text)) return { action: "continue" };
		void controller.setWaiting(ctx, false);
		controller.requestTitle(ctx, event.text);
		return { action: "continue" };
	});

	pi.on("agent_start", (_event, ctx) => { void controller.setWaiting(ctx, false); });
	// agent_end/turn_end can precede retries, tool work, or queued continuations.
	pi.on("agent_settled", (_event, ctx) => {
		const status = controller.setWaiting(ctx, true);
		controller.requestTitle(ctx);
		return status;
	});
	pi.on("session_start", (_event, ctx) => controller.restoreTitle(ctx));
	pi.on("session_tree", (_event, ctx) => controller.restoreTitle(ctx));
	pi.on("session_compact", (_event, ctx) => { controller.requestTitle(ctx); });
	// Reload and session replacement tear down extensions without exiting Pi.
	pi.on("session_shutdown", (event, ctx) => controller.reset(ctx, event.reason === "quit" ? "zsh" : undefined, event.reason !== "quit"));
}
