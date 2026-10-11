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
		`tskey-auth-${"A1b2".repeat(4)}`,
		`tskey-api-${"C3d4".repeat(5)}`,
		`tskey-client-${"E5f6".repeat(5)}`,
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
		`tskey-auth-${body.slice(0, 8)}\u200b${body.slice(8)}`,
		`tskey-\u200bauth-${body}`,
	];
	for (const key of obfuscatedKeys) {
		expect(hasSensitiveNamingContext(key)).toBe(true);
		expect(hasSensitiveOutput(key)).toBe(true);
	}

	for (const ordinaryText of [
		"tskey-123456789012345",
		"tskey-auth-________________",
		`tskey-other-${"A1b2".repeat(5)}`,
		"Tailscale auth-key setup",
	]) {
		expect(hasSensitiveNamingContext(ordinaryText)).toBe(false);
		expect(hasSensitiveOutput(ordinaryText)).toBe(false);
	}
	for (const subtype of ["auth", "api"]) {
		const shortTypedValue = ["tskey", subtype, "123456789012345"].join("-");
		expect(hasSensitiveNamingContext(shortTypedValue)).toBe(false);
		expect(hasSensitiveOutput(shortTypedValue)).toBe(false);
	}
});

test("screens synthetic Stripe webhook signing secrets without flagging short or prefixed near-misses", () => {
	const body = "A1b2".repeat(8);
	const secret = `whsec_${body}`;
	const obfuscatedValues = [
		`whsec_${body.slice(0, 16)}\u200b${body.slice(16)}`,
		`whsec\u200b_${body}`,
	];

	for (const value of [secret, ...obfuscatedValues]) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		`whsec_${"A1b2".repeat(5)}`,
		"whsec_example_secret",
		"Stripe webhook signing secret",
		`prefixwhsec_${body}`,
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens synthetic Slack webhook URLs without flagging similar links", () => {
	const token = "A1b2".repeat(10) + "A1b";
	const legacySecret = "C3d4".repeat(6);
	const legacyUrl = `https://hooks.slack.com/services/T00000000/B11111111/${legacySecret}`;
	const urls = [
		`https://hooks.slack.com/services/${token}`,
		`hooks.slack.com/workflows/${token}`,
		`http://hooks.slack.com/triggers/${token}`,
		`https://hooks.slack.com/services/${token.slice(0, 21)}\u200b${token.slice(21)}`,
		legacyUrl,
		legacyUrl.replace("hooks.slack.com", "hooks.slack.\u200bcom"),
		legacyUrl.replace(legacySecret, `${legacySecret.slice(0, 12)}\u200b${legacySecret.slice(12)}`),
	];

	for (const url of urls) {
		expect(hasSensitiveNamingContext(url)).toBe(true);
		expect(hasSensitiveOutput(url)).toBe(true);
	}

	for (const nearMiss of [
		`https://hooks.slack.com/services/${"A1b2".repeat(10) + "A1"}`,
		`https://hooks.slack.com/services/${token}${"A".repeat(14)}`,
		`https://hooks.slack.com.evil.test/services/${token}`,
		legacyUrl.replace("T00000000", "T0000000"),
		legacyUrl.replace("B11111111", "B1111111"),
		legacyUrl.replace(legacySecret, legacySecret.slice(1)),
		legacyUrl.replace(legacySecret, `${legacySecret}A`),
		legacyUrl.replace("/services/", "/service/"),
		legacyUrl.replace("hooks.slack.com", "hooks.slack.com.evil.test"),
		`https://hooks.slack.com/api/${token}`,
		"Slack webhook configuration",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens synthetic Discord webhook URLs without flagging similar links", () => {
	const id = "123456789012345678";
	const token = "A1b2".repeat(17);
	const url = `https://discord.com/api/webhooks/${id}/${token}`;
	const legacyUrl = url.replace("discord.com", "discordapp.com");
	const screenedUrls = [
		url.replace("discord.com", "dis\u200bcord.com"),
		url.replace(token, `${token.slice(0, 34)}\u200b${token.slice(34)}`),
		legacyUrl,
		legacyUrl.replace("discordapp.com", "discordapp.\u200bcom"),
		legacyUrl.replace(token, `${token.slice(0, 34)}\u200b${token.slice(34)}`),
	];

	for (const value of [url, ...screenedUrls]) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		url.replace(id, id.slice(1)),
		url.replace(token, token.slice(0, -1)),
		url.replace(token, `${token}a`),
		url.replace("discord.com", "discord.com.evil.test"),
		legacyUrl.replace("discordapp.com", "discordapp.com.evil.test"),
		url.replace("/api/webhooks/", "/api/webhook/"),
		url.replace("https://", "http://"),
		`prefix${url}`,
		"Discord webhook setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens synthetic Microsoft Teams incoming webhook URLs without flagging similar links", () => {
	const guid = "01234567-89ab-cdef-0123-456789abcdef";
	const otherGuid = "fedcba98-7654-3210-fedc-ba9876543210";
	const token = "a1b2c3d4".repeat(4);
	const url = `https://tenant.webhook.office.com/webhookb2/${guid}@${otherGuid}/IncomingWebhook/${token}/${guid}`;
	const obfuscatedUrls = [
		url.replace("webhook.office.com", "webhook.office.\u200bcom"),
		url.replace("IncomingWebhook", "Incoming\u200bWebhook"),
	];

	for (const value of [url, ...obfuscatedUrls]) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		url.replace("webhook.office.com", "webhook.office.com.evil.test"),
		url.replace("webhookb2", "api"),
		url.replace(token, `${token}a`),
		url.replace("https://", "http://"),
		`prefix${url}`,
		"Microsoft Teams webhook setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
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
