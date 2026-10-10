import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestNamingTitle, UnsafeNamingContextError } from "../src/naming.ts";

test("requestNamingTitle screens context before model-registry access", async () => {
	const contextText = "task: pi-tmux@example.invalid";
	const context = {
		get modelRegistry() {
			throw new Error("Sensitive context must be rejected before model-registry access");
		},
	} as unknown as ExtensionContext;
	let error: unknown;
	try {
		await requestNamingTitle(
			contextText,
			context,
			{ provider: "openai-codex", id: "gpt-6-luna" },
			new AbortController().signal,
			() => true,
		);
	} catch (caught) {
		error = caught;
	}

	expect(error).toBeInstanceOf(UnsafeNamingContextError);
	expect((error as Error).message).toBe("Naming context looked like it contained sensitive data");
	expect((error as Error).message).not.toContain("example.invalid");
});
