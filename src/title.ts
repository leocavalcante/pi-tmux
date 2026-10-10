export const MAX_TITLE_LENGTH = 24;
// Bound raw user-controlled title text passed through screening and normalization.
export const MAX_TITLE_INPUT_LENGTH = 64 * 1024;
export const READY_PREFIX = "* ";

// ASCII keeps the character cap equal to the status bar's display width.
export function cleanTitle(text: string, maxLength = MAX_TITLE_LENGTH): string {
	if (maxLength <= 0) return "";
	const title = text
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/[^a-zA-Z0-9 ._-]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	if (!/[a-zA-Z0-9]/.test(title)) return "";
	if (title.length <= maxLength) return title;
	const clipped = title.slice(0, maxLength);
	const wordBoundary = clipped.lastIndexOf(" ");
	return (wordBoundary > 0 ? clipped.slice(0, wordBoundary) : clipped).trim();
}

export function formatTitle(title: string, waiting: boolean): string {
	const prefix = waiting ? READY_PREFIX : "";
	return prefix + (cleanTitle(title, MAX_TITLE_LENGTH - prefix.length) || "pi");
}
