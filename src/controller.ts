import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildNamingContext,
	InvalidNamingTitleError,
	UnsafeNamingOutputError,
	NAMING_REQUEST_TIMEOUT_MS,
	parseNamingModel,
	requestNamingTitle,
} from "./naming.ts";
import { formatTitle, READY_PREFIX } from "./title.ts";
import {
	ACTIVE_OPTION,
	buildWindowTitleFormat,
	QUIT_TITLE_FORMAT,
	readWindowTitle,
	SESSION_BASE_NAME_OPTION,
	SESSION_BASE_NAME_TITLE_FORMAT,
	SESSION_BASE_NAME_UPDATE_FORMAT,
	SESSION_TITLE_FORMAT,
	SESSION_TITLE_MARKED_OPTION,
	SESSION_TITLE_MARKED_VALUE_FORMAT,
	SHARED_TASK_TITLE_FORMAT,
	PRESERVED_WINDOW_TITLE_FORMAT,
	STATUS_INFO_FORMAT,
	targetDisappeared,
	WINDOW_REPAIR_NEEDED_FORMAT,
	WAITING_OPTION,
	writeOnServer,
	type RunTmux,
	type WindowSnapshot,
} from "./tmux.ts";

const MAX_FORMER_TARGETS = 8;
const MAX_LOCATION_PASSES = 4;

export function createController(tmux: RunTmux) {
	let namingModel: ReturnType<typeof parseNamingModel> = null;
	let invalidModelSetting = false;
	try {
		namingModel = parseNamingModel(process.env.PI_TMUX_MODEL);
	} catch {
		invalidModelSetting = true;
	}
	let pending: AbortController | undefined;
	let generation = 0;
	let warned = false;
	let baseTitle: string | undefined;
	let manualTitle = false;
	let candidateTitle: string | undefined;
	let lastNamingContext: string | undefined;
	let waiting = false;
	let active = true;
	let titleRevision = 0;
	let titleLifetime = new AbortController();
	let titleQueue: Promise<void> = Promise.resolve();
	// Retain locations across lifecycle resets so interrupted move repairs can finish.
	let lastLocation: { session: string; window: string; server?: string } | undefined;
	let serverIdentityChanged = false;
	const formerWindows = new Set<string>();
	const formerSessions = new Set<string>();

	const cancel = () => {
		generation++;
		pending?.abort();
		pending = undefined;
		candidateTitle = undefined;
	};

	const getPane = (ctx: ExtensionContext) => {
		const pane = process.env.TMUX_PANE;
		return ctx.mode === "tui" && pane && /^%\d+$/.test(pane) ? pane : undefined;
	};

	const warnOnce = (ctx: ExtensionContext, message: string) => {
		if (warned) return;
		warned = true;
		ctx.ui.notify(message, "warning");
	};

	const trackedSessions = new Set<string>();
	const rememberLocation = (location: WindowSnapshot) => {
		// Once the server changes, the inherited TMUX_PANE could name an unrelated
		// reused pane. Discard cached IDs and stop writes rather than claim ownership.
		if (lastLocation?.server && location.server && lastLocation.server !== location.server) {
			serverIdentityChanged = true;
			formerWindows.clear();
			formerSessions.clear();
			trackedSessions.clear();
			lastLocation = undefined;
			baseTitle = undefined;
			manualTitle = false;
			lastNamingContext = undefined;
			cancel();
			titleRevision++;
			titleLifetime.abort();
			titleLifetime = new AbortController();
			return;
		}
		if (location.sessionMetadataAvailable) trackedSessions.add(location.session);
		const queue = (targets: Set<string>, target: string) => {
			targets.add(target);
			if (targets.size > MAX_FORMER_TARGETS) targets.delete(targets.values().next().value!);
		};
		const queueFormerSession = (target: string) => {
			formerSessions.add(target);
			if (formerSessions.size > MAX_FORMER_TARGETS) {
				const evicted = formerSessions.values().next().value!;
				formerSessions.delete(evicted);
				// Keep metadata for a session that has become current again.
				if (evicted !== location.session) trackedSessions.delete(evicted);
			}
		};
		if (lastLocation && lastLocation.window !== location.window) queue(formerWindows, lastLocation.window);
		if (lastLocation && lastLocation.session !== location.session) queueFormerSession(lastLocation.session);
		formerWindows.delete(location.window);
		formerSessions.delete(location.session);
		lastLocation = {
			session: location.session,
			window: location.window,
			server: location.server ?? lastLocation?.server,
		};
	};

	const repairFormerLocations = async (server: string | undefined, signal: AbortSignal, isCurrent: () => boolean) => {
		for (const window of [...formerWindows]) {
			if (!isCurrent()) return;
			try {
				// -F evaluates a format, not a shell command. Only validated numeric
				// IDs enter this fixed tmux command; title text is expanded at rename.
				// Skip unchanged names on the server, preserving automatic-rename even
				// if a custom unmarked name replaced the stale marker after lookup.
				await writeOnServer(tmux, server, [
					"if-shell", "-F", "-t", window, WINDOW_REPAIR_NEEDED_FORMAT,
					`rename-window -t ${window} -- '${SHARED_TASK_TITLE_FORMAT}'`,
				], signal);
			} catch (error) {
				// Forget vanished windows, but retry transient failures on the next update.
				if (!targetDisappeared(error, window)) continue;
			}
			if (!isCurrent()) return;
			formerWindows.delete(window);
		}
		for (const session of [...formerSessions]) {
			if (!isCurrent()) return;
			try {
				if (trackedSessions.has(session)) {
					await writeOnServer(tmux, server, [
						"set-option", "-F", "-t", session, SESSION_BASE_NAME_OPTION, SESSION_BASE_NAME_UPDATE_FORMAT,
						";", "set-option", "-t", session, SESSION_TITLE_MARKED_OPTION, "transition",
					], signal);
					// Keep rename-session as its own command for existing RunTmux wrappers
					// that identify former-location repairs by the top-level command.
					await writeOnServer(tmux, server, ["rename-session", "-t", session, SESSION_BASE_NAME_TITLE_FORMAT], signal);
					await writeOnServer(tmux, server, [
						"set-option", "-F", "-t", session, SESSION_TITLE_MARKED_OPTION, SESSION_TITLE_MARKED_VALUE_FORMAT,
					], signal);
				} else {
					await writeOnServer(tmux, server, ["rename-session", "-t", session, SESSION_TITLE_FORMAT], signal);
				}
			} catch (error) {
				if (!targetDisappeared(error, session)) continue;
			}
			if (!isCurrent()) return;
			formerSessions.delete(session);
			trackedSessions.delete(session);
		}
	};

	const refreshTitle = (ctx: ExtensionContext, pane: string, requestGeneration?: number) => {
		const revision = ++titleRevision;
		const signal = titleLifetime.signal;
		let updated = false;
		// Compaction can supersede naming after its model result has completed,
		// while a queued tmux lookup is still pending. Status-only writes remain
		// independent of naming generations.
		const isCurrent = () => !serverIdentityChanged && !signal.aborted && revision === titleRevision
			&& (requestGeneration === undefined || requestGeneration === generation);
		// Serialize writes so a slow rename cannot overwrite a newer status.
		titleQueue = titleQueue.then(async () => {
			if (!isCurrent()) return;
			// Validate the pane's current window before updating its status.
			let current = await readWindowTitle(tmux, pane, signal);
			if (!isCurrent()) return;
			rememberLocation(current);
			if (!isCurrent()) return;
			// A pane can move again during marker writes or former-location repair.
			// Refresh the new session and drain new targets, but bound repeated moves.
			let stable = false;
			for (let pass = 0; pass < MAX_LOCATION_PASSES; pass++) {
				const before = current;
				// Keep the user's session name intact, aggregating waiting panes on
				// the server. Target the pane so writes follow moves after lookup.
				if (current.sessionMetadataAvailable || trackedSessions.has(current.session)) {
					trackedSessions.add(current.session);
					await writeOnServer(tmux, current.server ?? lastLocation?.server, [
						"set-option", "-F", "-t", pane, SESSION_BASE_NAME_OPTION, SESSION_BASE_NAME_UPDATE_FORMAT,
						";", "set-option", "-p", "-t", pane, WAITING_OPTION, waiting ? "1" : "0",
						";", "set-option", "-p", "-t", pane, ACTIVE_OPTION, active ? "1" : "0",
						";", "set-option", "-t", pane, SESSION_TITLE_MARKED_OPTION, "transition",
						";", "rename-session", "-t", pane, SESSION_BASE_NAME_TITLE_FORMAT,
						";", "set-option", "-F", "-t", pane, SESSION_TITLE_MARKED_OPTION, SESSION_TITLE_MARKED_VALUE_FORMAT,
					], signal);
				} else {
					await writeOnServer(tmux, current.server ?? lastLocation?.server, [
						"set-option", "-p", "-t", pane, WAITING_OPTION, waiting ? "1" : "0",
						";", "set-option", "-p", "-t", pane, ACTIVE_OPTION, active ? "1" : "0",
						";", "rename-session", "-t", pane, SESSION_TITLE_FORMAT,
					], signal);
				}
				if (!isCurrent()) return;
				// Resolve the fallback title and destination after the marker write.
				current = await readWindowTitle(tmux, pane, signal);
				if (!isCurrent()) return;
				rememberLocation(current);
				if (!isCurrent()) return;
				const afterWrite = current;
				if (formerWindows.size || formerSessions.size) {
					await repairFormerLocations(current.server ?? lastLocation?.server, signal, isCurrent);
					if (!isCurrent()) return;
					current = await readWindowTitle(tmux, pane, signal);
					if (!isCurrent()) return;
					rememberLocation(current);
					if (!isCurrent()) return;
				}
				if (before.window === current.window && before.session === current.session
					&& afterWrite.window === current.window && afterWrite.session === current.session) {
					stable = true;
					break;
				}
			}
			const { title: currentTitle, waiting: windowWaiting } = current;
			// Keep model output provisional until its tmux update succeeds. A failed
			// or superseded write must not affect later status-only title decisions.
			const candidate = candidateTitle;
			// Leave a custom name alone unless we have a summary or a marker to update.
			if (!candidate && !baseTitle && !windowWaiting && !currentTitle.startsWith(READY_PREFIX)) {
				updated = isCurrent() && stable;
				return;
			}
			const hasTaskTitle = candidate !== undefined || baseTitle !== undefined;
			const taskTitle = candidate ?? baseTitle ?? currentTitle.replace(/^\* /, "");
			const preserveWindowName = !hasTaskTitle && taskTitle.length > 0;
			const title = preserveWindowName
				? `${windowWaiting ? READY_PREFIX : ""}${taskTitle}`
				: formatTitle(taskTitle, windowWaiting);
			if (title !== currentTitle) {
				// Rename the pane's current window, aggregating its current statuses on
				// the server rather than trusting the earlier client-side snapshot.
				const renameLocation = current;
				const format = !active && taskTitle === "zsh" ? QUIT_TITLE_FORMAT
					: preserveWindowName ? PRESERVED_WINDOW_TITLE_FORMAT : buildWindowTitleFormat(taskTitle);
				await writeOnServer(tmux, current.server ?? lastLocation?.server, ["rename-window", "-t", pane, "--", format], signal);
				if (!isCurrent()) return;
				// A guarded write can succeed as a tmux command while its PID condition
				// skips the rename after a server restart. Confirm the server identity
				// before treating the candidate or an explicit pin as applied.
				if (renameLocation.server && tmux.supportsServerPidGuard) {
					current = await readWindowTitle(tmux, pane, signal);
					if (!isCurrent()) return;
					rememberLocation(current);
					if (!isCurrent()) return;
					if (current.window !== renameLocation.window || current.session !== renameLocation.session) stable = false;
				}
			}
			if (!isCurrent()) return;
			// Preserve a current candidate after failures so /tmux-title sync can
			// retry it; commit only after a successful, still-current update.
			if (candidate !== undefined && candidateTitle === candidate) {
				baseTitle = candidate;
				candidateTitle = undefined;
			}
			updated = stable;
		}).catch(() => {
			if (isCurrent()) {
				warnOnce(ctx, "tmux window/session status could not be updated. Check tmux.");
			}
		});
		return titleQueue.then(() => updated);
	};

	const setWaiting = (ctx: ExtensionContext, value: boolean) => {
		const pane = getPane(ctx);
		if (!pane) return;
		waiting = value;
		// Lifecycle notifications keep their Promise<void> contract.
		return refreshTitle(ctx, pane).then(() => {});
	};

	const reset = (ctx: ExtensionContext, title?: string, alive = true) => {
		cancel();
		titleLifetime.abort();
		titleLifetime = new AbortController();
		baseTitle = title;
		active = alive;
		manualTitle = false;
		lastNamingContext = undefined;
		return setWaiting(ctx, false);
	};

	const nameWindow = async (
		text: string,
		pane: string,
		ctx: ExtensionContext,
		controller: AbortController,
		requestGeneration: number,
	) => {
		const timeout = setTimeout(() => controller.abort(), NAMING_REQUEST_TIMEOUT_MS);
		timeout.unref();
		const isCurrent = () => requestGeneration === generation;
		try {
			if (!namingModel) return;
			const title = await requestNamingTitle(text, ctx, namingModel, controller.signal, isCurrent);
			if (title === undefined || controller.signal.aborted || !isCurrent()) return;
			candidateTitle = title;
			// A late summary must retain the latest busy/waiting status.
			void refreshTitle(ctx, pane, requestGeneration);
		} catch (error) {
			if (!isCurrent()) return;
			warnOnce(ctx, error instanceof UnsafeNamingOutputError
				? "Sensitive-looking naming output was not applied."
				: error instanceof InvalidNamingTitleError
					? "The naming model did not return a short title; the current title was kept."
					: "tmux title could not be updated. Check the configured naming model, its Pi credentials, and tmux. Use /tmux-title to retry.");
		} finally {
			clearTimeout(timeout);
			if (pending === controller) pending = undefined;
		}
	};

	const requestTitle = (ctx: ExtensionContext, prompt = "", force = false) => {
		const pane = getPane(ctx);
		if (!pane || manualTitle || serverIdentityChanged) return false;
		if (invalidModelSetting) {
			warnOnce(ctx, "Invalid PI_TMUX_MODEL. Set provider/model or off, then /reload. Naming is disabled; waiting markers still work.");
		}
		if (!namingModel) return false;
		let text: string;
		try {
			text = buildNamingContext(ctx.sessionManager.buildSessionProjection().messages, prompt);
		} catch {
			// Do not let a transient session-projection failure escape a Pi event or
			// leave an older request eligible to rename the window with stale context.
			cancel();
			lastNamingContext = undefined;
			warnOnce(ctx, "Pi session context could not be read. The tmux title was not updated.");
			return undefined;
		}
		if (!force && text === lastNamingContext) return false;
		// Empty projected context still supersedes work based on removed dialogue.
		cancel();
		lastNamingContext = text;
		if (!text) return false;
		const controller = new AbortController();
		pending = controller;
		// Do not await: naming must never delay the agent's response.
		void nameWindow(text, pane, ctx, controller, generation);
		return true;
	};

	const restoreTitle = (ctx: ExtensionContext) => {
		const status = reset(ctx);
		requestTitle(ctx);
		return status;
	};

	const status = async (ctx: ExtensionContext, pane: string) => {
		const signal = titleLifetime.signal;
		try {
			const info = await tmux(["display-message", "-p", "-t", pane, STATUS_INFO_FORMAT], signal);
			if (signal.aborted) return;
			const fields = info.split("\t");
			const [session, window, paneWaiting, windowWaiting, sessionWaiting] = fields;
			if (fields.length !== 5 || !/^\$\d+$/.test(session) || !/^@\d+$/.test(window)
				|| !fields.slice(2).every((value) => /^[01]$/.test(value))) throw new Error("Invalid tmux status");
			const yesNo = (value: string) => value === "1" ? "yes" : "no";
			ctx.ui.notify([
				"tmux title status",
				`Title mode: ${manualTitle ? "manual" : "automatic"}`,
				`AI naming: ${invalidModelSetting ? "invalid configuration" : namingModel ? "configured" : "off"}`,
				`Naming request: ${pending ? "pending" : candidateTitle ? "ready to apply" : "idle"}`,
				`Local waiting: ${waiting ? "yes" : "no"}`,
				`Targets: pane ${pane}, window ${window}, session ${session}`,
				`Waiting flags: pane ${yesNo(paneWaiting)}, window ${yesNo(windowWaiting)}, session ${yesNo(sessionWaiting)}`,
				`Pending move repairs: windows ${formerWindows.size}, sessions ${formerSessions.size}`,
			].join("\n"), "info");
		} catch {
			if (!signal.aborted) ctx.ui.notify("tmux status could not be read. Check tmux.", "warning");
		}
	};

	const sync = async (ctx: ExtensionContext, pane: string) => {
		const signal = titleLifetime.signal;
		warned = false;
		const update = refreshTitle(ctx, pane);
		const revision = titleRevision;
		if (await update && !signal.aborted && revision === titleRevision) {
			ctx.ui.notify(formerWindows.size || formerSessions.size
				? "Current tmux status synchronized; some former-location repairs remain queued."
				: "tmux title and waiting markers synchronized.", "info");
		}
	};

	const pinTitle = async (ctx: ExtensionContext, pane: string, title: string) => {
		warned = false;
		cancel();
		manualTitle = true;
		baseTitle = title;
		lastNamingContext = undefined;
		const signal = titleLifetime.signal;
		const commandGeneration = generation;
		const update = refreshTitle(ctx, pane);
		const revision = titleRevision;
		if (await update && !signal.aborted && revision === titleRevision && manualTitle
			&& baseTitle === title && generation === commandGeneration) {
			ctx.ui.notify("Manual title pinned. Use /tmux-title auto to resume automatic naming.", "info");
		}
	};

	const refresh = (ctx: ExtensionContext) => {
		if (manualTitle) {
			ctx.ui.notify("Manual title is pinned. Use /tmux-title auto to resume automatic naming.", "info");
			return;
		}
		// Explicit retries can report a new failure after the one-time warning.
		warned = false;
		if (!namingModel) {
			if (invalidModelSetting) requestTitle(ctx);
			else ctx.ui.notify("AI naming is disabled by PI_TMUX_MODEL=off; waiting markers still work.", "info");
			return;
		}
		const requested = requestTitle(ctx, "", true);
		if (requested !== undefined) {
			ctx.ui.notify(requested
				? "Requested a tmux title refresh."
				: "No text in the active session to name.", "info");
		}
	};

	const resumeAutomaticNaming = () => { manualTitle = false; };

	return {
		getPane,
		setWaiting,
		reset,
		restoreTitle,
		requestTitle,
		status,
		sync,
		pinTitle,
		refresh,
		resumeAutomaticNaming,
	};
}
