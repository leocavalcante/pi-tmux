import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type NotificationLevel = "info" | "warning";

// A disposed Pi UI must not turn a completed tmux update into a command failure.
export function notifySafely(ctx: ExtensionContext, message: string, level: NotificationLevel): void {
	try {
		ctx.ui.notify(message, level);
	} catch {
		// Notifications are best-effort; state changes and lifecycle work remain authoritative.
	}
}
