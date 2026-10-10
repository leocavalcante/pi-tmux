import { rmSync } from "node:fs";

export function supportsUnixTmux(platform: string, tmuxPath: string | null): boolean {
	return platform !== "win32" && tmuxPath !== null;
}

export function cleanupTmuxFixture(stopServer: () => unknown, directory: string): void {
	// Cleanup is best-effort so a missing server does not replace the test failure.
	try { stopServer(); } catch { /* It may not have started or may have exited already. */ }
	try { rmSync(directory, { recursive: true, force: true }); } catch { /* Cleanup must not mask the test result. */ }
}
