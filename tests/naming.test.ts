import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	hasSensitiveNamingContext,
	hasSensitiveOutput,
	requestNamingTitle,
	UnsafeNamingContextError,
} from "../src/naming.ts";

test("screens synthetic Tailscale key strings in context and output", () => {
	const keys = [
		`tskey-${"A1b2".repeat(4)}`,
		`tskey-${"C3d4".repeat(9)}`,
		`tskey-${"E5f6".repeat(9)}`,
	];

	for (const key of keys) {
		expect(hasSensitiveNamingContext(`provision Tailscale auth key ${key}`)).toBe(true);
		expect(hasSensitiveOutput(key)).toBe(true);
	}
});

test("screens Tailscale keys with invisible formatting without flagging ordinary setup text", () => {
	const body = "A1b2C3d4E5f6G7h8";
	const obfuscatedKeys = [
		`ts\u200bkey-${body}`,
		`tskey-${body.slice(0, 8)}\u200b${body.slice(8)}`,
	];
	for (const key of obfuscatedKeys) {
		expect(hasSensitiveNamingContext(key)).toBe(true);
		expect(hasSensitiveOutput(key)).toBe(true);
	}

	for (const ordinaryText of [
		"tskey-123456789012345",
		"Tailscale auth-key setup",
	]) {
		expect(hasSensitiveNamingContext(ordinaryText)).toBe(false);
		expect(hasSensitiveOutput(ordinaryText)).toBe(false);
	}
});

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
