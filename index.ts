export { default } from "./src/extension.ts";

export { cleanTitle, formatTitle, MAX_TITLE_LENGTH, READY_PREFIX } from "./src/title.ts";
export {
	buildNamingContext,
	MAX_CONTEXT_LENGTH,
	MAX_HISTORY_MESSAGES,
	MAX_PROMPT_LENGTH,
	parseNamingModel,
} from "./src/naming.ts";
export {
	ACTIVE_OPTION,
	buildWindowTitleFormat,
	QUIT_TITLE_FORMAT,
	SESSION_TITLE_FORMAT,
	SESSION_WAITING_FORMAT,
	STATUS_INFO_FORMAT,
	WAITING_OPTION,
	WINDOW_ACTIVE_FORMAT,
	WINDOW_INFO_FORMAT,
	WINDOW_WAITING_FORMAT,
} from "./src/tmux.ts";
export type { RunTmux } from "./src/tmux.ts";
