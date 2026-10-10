export function supportsUnixTmux(platform: string, tmuxPath: string | null): boolean {
	return platform !== "win32" && tmuxPath !== null;
}
