import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildNamingContext,
	buildNamingRequestContext,
	hasSensitiveNamingContext,
	hasSensitiveOutput,
	MAX_PROMPT_LENGTH,
	requestNamingTitle,
	UnsafeNamingContextError,
} from "../src/naming.ts";

test("screens synthetic 1Password service-account tokens without mistaking near-misses", () => {
	const body = "Aa0+/".repeat(50);
	const token = `ops_eyJ${body}`;
	const obfuscatedTokens = [
		token.replace("ops_", "op\u200bs_"),
		token.replace("eyJ", "ey\u200bJ"),
		token.replace(body.slice(0, 100), `${body.slice(0, 100)}\u200b`),
	];

	for (const value of [token, `${token}==`, ...obfuscatedTokens]) {
		expect(hasSensitiveNamingContext(`configure the vault integration ${value}`)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		`ops_eyJ${body.slice(0, 249)}`,
		`ops_eyJ${body.replace("A", "!")}`,
		`ops_eyK${body}`,
		`prefix${token}`,
		"1Password service account setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens Pinecone API keys without flagging near-misses", () => {
	const secret = "A".repeat(63);
	const keyFor = (keyId = "id123", value = secret) => `pcsk_${keyId}_${value}`;
	const keys = [keyFor(), keyFor("id1234")];
	const obfuscatedKeys = [
		keys[0]!.toUpperCase(),
		keys[0]!.replace("pcsk_", "pc\u200bsk_"),
		keys[0]!.replace("id123", "id\u200b123"),
		keys[0]!.replace(secret.slice(0, 31), `${secret.slice(0, 31)}\u200b`),
	];

	for (const value of [...keys, ...obfuscatedKeys]) {
		expect(hasSensitiveNamingContext(`review Pinecone access ${value}`)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		keyFor("id12"),
		keyFor("id12345"),
		keyFor("id123", "A".repeat(62)),
		keyFor("id123", "A".repeat(64)),
		keyFor("id123", `${"A".repeat(62)}!`),
		`prefix${keys[0]}`,
		`_${keys[0]}`,
		`-${keys[0]}`,
		`${keys[0]}x`,
		`${keys[0]}_suffix`,
		"Pinecone index setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens Railway UUID tokens only when Railway context is present", () => {
	const token = ["a".repeat(8), "b".repeat(4), "c".repeat(4), "d".repeat(4), "e".repeat(12)].join("-");
	const labeledValues = [
		`Railway: ${token}`,
		`Railway token: ${token}`,
		`Railway API token: ${token}`,
		`RAILWAY_TOKEN=${token}`,
		`RAILWAY_API_TOKEN=${token}`,
	];
	const obfuscatedValues = [
		labeledValues[0]!.replace("Railway", "Rail\u200bway"),
		`Railway token: ${token.slice(0, 16)}\u200b${token.slice(16)}`,
	];

	for (const value of [...labeledValues, ...obfuscatedValues]) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		token,
		`project id: ${token}`,
		`Railway ${token}`,
		`Railway: ${token.slice(1)}`,
		`Railway: ${token.replace("a", "g")}`,
		`Railway: ${token}x`,
		"Railway deployment setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens Vercel tokens only when a Vercel label is present", () => {
	const token = "A1b2".repeat(6);
	const labeledValues = [
		`Vercel: ${token}`,
		`Vercel API token: ${token}`,
		`VERCEL_TOKEN=${token}`,
	];
	const obfuscatedValues = [
		labeledValues[0]!.replace("Vercel", "Ver\u200bcel"),
		`Vercel: ${token.slice(0, 12)}\u200b${token.slice(12)}`,
	];

	for (const value of [...labeledValues, ...obfuscatedValues]) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		token,
		`release ${token}`,
		`Vercel ${token}`,
		`Vercel: ${token.slice(1)}`,
		`Vercel: ${token}x`,
		`Vercel: ${token.replace("A", "!")}`,
		`Vercel: ${token}_`,
		"Vercel deployment setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens Vercel tokens that overlap retained-context truncation boundaries", () => {
	const token = "A1b2".repeat(6);
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const suffixLength = Math.floor(retainedLength / 2);

	const prefixTokenStart = prefixLength - 10;
	const prefixPrompt = `${"x".repeat(prefixTokenStart - 9)} Vercel: ${token} ${"x".repeat(1_200)}`;
	const prefixContext = buildNamingRequestContext([], prefixPrompt);
	expect(hasSensitiveNamingContext(prefixContext.text)).toBe(false);
	expect(prefixContext.hasSensitiveBoundary()).toBe(true);
	expect(prefixContext.text).toBe(buildNamingContext([], prefixPrompt));
	const obfuscatedPrompt = prefixPrompt.replace(token.slice(0, 5), `${token.slice(0, 5)}\u200b`);
	expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);
	const controlObfuscatedPrompt = prefixPrompt.replace(token.slice(0, 5), `${token.slice(0, 5)}\u0000`);
	expect(buildNamingRequestContext([], controlObfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixStart = promptLength - suffixLength;
	const suffixTokenStart = suffixStart - 10;
	const suffixPrompt = `${"x".repeat(suffixTokenStart - 9)} Vercel: ${token} ${"y".repeat(promptLength - suffixTokenStart - 25)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);
	expect(suffixContext.text).toBe(buildNamingContext([], suffixPrompt));

	const historyContent = `${"x".repeat(981)} Vercel: ${token} y`;
	const historyContext = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(historyContext.text)).toBe(false);
	expect(historyContext.hasSensitiveBoundary()).toBe(true);

	const summaryContent = `${"x".repeat(981)} Vercel: ${token} y`;
	const summaryContext = buildNamingRequestContext([{ role: "compactionSummary", summary: summaryContent }] as any);
	expect(hasSensitiveNamingContext(summaryContext.text)).toBe(false);
	expect(summaryContext.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)} Vercel: ${token} ${"y".repeat(3_000)}`;
	const omittedContext = buildNamingRequestContext([], omittedPrompt);
	expect(hasSensitiveNamingContext(omittedContext.text)).toBe(false);
	expect(omittedContext.hasSensitiveBoundary()).toBe(false);
	const omittedHistoryContent = `${"x".repeat(1_010)} Vercel: ${token} y`;
	const omittedHistory = buildNamingRequestContext([{ role: "user", content: omittedHistoryContent }] as any);
	expect(omittedHistory.hasSensitiveBoundary()).toBe(false);
	const omittedSummary = buildNamingRequestContext([{ role: "compactionSummary", summary: omittedHistoryContent }] as any);
	expect(omittedSummary.hasSensitiveBoundary()).toBe(false);
});

test("screens Alibaba Cloud AccessKey IDs without flagging near-misses", () => {
	const key = `LTAI${"A1b2".repeat(5)}`;
	const obfuscatedKeys = [
		key.replace("LTAI", "LT\u200bAI"),
		`${key.slice(0, 12)}\u200b${key.slice(12)}`,
	];

	for (const value of [key, ...obfuscatedKeys]) {
		expect(hasSensitiveNamingContext(`review Alibaba Cloud access ${value}`)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		`LTAI${"A1b2".repeat(4)}A1b`,
		`LTAI${"A1b2".repeat(5)}A`,
		`LTAJ${"A1b2".repeat(5)}`,
		`prefix${key}`,
		`${key}suffix`,
		"Alibaba Cloud AccessKey setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens Tencent Cloud SecretIds without flagging near-misses", () => {
	const secretId = `AKID${"A1b2".repeat(8)}`;
	const obfuscatedSecretIds = [
		secretId.replace("AKID", "A\u200bKID"),
		`${secretId.slice(0, 20)}\u200b${secretId.slice(20)}`,
	];

	for (const value of [secretId, ...obfuscatedSecretIds]) {
		expect(hasSensitiveNamingContext(`review Tencent Cloud access ${value}`)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		`AKID${"A1b2".repeat(7)}A1b`,
		`AKID${"A1b2".repeat(8)}A`,
		`AKIE${"A1b2".repeat(8)}`,
		`prefix${secretId}`,
		`${secretId}suffix`,
		"Tencent Cloud SecretId setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens synthetic Square access tokens without flagging near-misses", () => {
	const squareToken = `sq0atp-${"A1_-".repeat(6)}`;
	const legacySquareToken = `EAAA${"B2_c".repeat(6)}`;
	const obfuscatedTokens = [
		squareToken.replace("sq0atp-", "sq0\u200batp-"),
		`${squareToken.slice(0, 18)}\u200b${squareToken.slice(18)}`,
		legacySquareToken.replace("EAAA", "EA\u200bAA"),
	];

	for (const value of [squareToken, legacySquareToken, `sq0atp-${"A".repeat(22)}`, `EAAA${"B".repeat(60)}`, ...obfuscatedTokens]) {
		expect(hasSensitiveNamingContext(`review payment integration ${value}`)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		`sq0atp-${"A".repeat(21)}`,
		`sq0atp-${"A".repeat(61)}`,
		`EAAA${"B".repeat(21)}`,
		`EAAA${"B".repeat(61)}`,
		`sq0atq-${"A".repeat(24)}`,
		`sq0atp-${"A".repeat(10)}!${"A".repeat(14)}`,
		`prefix${squareToken}`,
		`sq0atp-${"A".repeat(60)}suffix`,
		`EAAA${"B".repeat(60)}suffix`,
		"Square access token integration",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens assigned access-key values without mistaking placeholders or short values for credentials", () => {
	const credentialValues = [
		`access_key=${"A1b2".repeat(6)}`,
		`accessKeyId:${"C3d4".repeat(6)}`,
		`AWS_ACCESS_KEY_ID=${"E5f6".repeat(5)}`,
		`Access Key = ${"G7h8".repeat(6)}`,
		`access_\u200bkey=${"J9k0".repeat(6)}`,
	];

	for (const value of credentialValues) {
		expect(hasSensitiveNamingContext(`review cloud configuration ${value}`)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		"access_key=placeholder",
		"access_key=example",
		`access_key=${"A".repeat(19)}`,
		"access_key_id: redacted",
		"access key configuration",
		"review key access tests",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens Azure AD client-secret formats without flagging near-misses", () => {
	const body = `${"Aa0_-.".repeat(5)}C3`;
	const secrets = [`AbC7Q~${body}`, `AbC7Q~${body.slice(0, 31)}`, `AbC7Q~${body}${"x".repeat(2)}`];
	const obfuscatedSecrets = [
		secrets[0]!.replace("Q~", "Q\u200b~"),
		secrets[0]!.replace("AbC7", "Ab\u200bC7"),
		secrets[0]!.replace(body.slice(0, 16), `${body.slice(0, 16)}\u200b`),
	];

	for (const value of [...secrets, ...obfuscatedSecrets]) {
		expect(hasSensitiveNamingContext(`Review Azure AD application access ${value}`)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		`AbC7Q~${body.slice(0, 30)}`,
		`AbC7Q~${body}${"x".repeat(3)}`,
		`AbC7R~${body}`,
		secrets[0]!.replace("Aa", "A!"),
		`prefix${secrets[0]}`,
		`${secrets[0]}suffix`,
		"Azure AD application registration setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

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

test("screens Stripe secret API keys in supported modes without flagging near-misses", () => {
	const keys = [
		...(["live", "test", "prod"] as const).flatMap((mode) => [
			`sk_${mode}_${"A1b2".repeat(6)}`,
			`rk_${mode}_${"C3d4".repeat(6)}`,
		]),
	];
	const obfuscatedKeys = [
		keys[4]!.replace("prod", "pr\u200bod"),
		keys[5]!.replace("C3d4".repeat(3), `${"C3d4".repeat(3)}\u200b`),
	];

	for (const value of [...keys, ...obfuscatedKeys, `sk_prod_${"A".repeat(16)}`]) {
		expect(hasSensitiveNamingContext(`review payment processing ${value}`)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		`sk_prod_${"A".repeat(15)}`,
		`rk_prod_${"C".repeat(15)}`,
		`pk_prod_${"A".repeat(24)}`,
		`sk_production_${"A".repeat(24)}`,
		`sk_prod_${"A".repeat(10)}!${"A".repeat(14)}`,
		"Stripe production API key setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens Typeform API tokens by exact prefix and length without flagging near-misses", () => {
	const body = `${"A1._-=".repeat(9)}A1._-`;
	const token = `tfp_${body}`;
	const obfuscatedTokens = [
		token.replace("tfp_", "tf\u200bp_"),
		`${token.slice(0, 30)}\u200b${token.slice(30)}`,
	];

	for (const value of [token, token.toUpperCase(), ...obfuscatedTokens]) {
		expect(hasSensitiveNamingContext(`review survey integration ${value}`)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		`tfp_${body.slice(0, 58)}`,
		`tfp_${body}A`,
		`tfq_${body}`,
		`tfp_${body.slice(0, 20)}!${body.slice(20)}`,
		`prefix${token}`,
		`_${token}`,
		"Typeform API token setup",
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
	const underscoreToken = "A1b_".repeat(17);
	const underscoreUrl = url.replace(token, underscoreToken);
	const screenedUrls = [
		url.replace("discord.com", "dis\u200bcord.com"),
		url.replace(token, `${token.slice(0, 34)}\u200b${token.slice(34)}`),
		legacyUrl,
		legacyUrl.replace("discordapp.com", "discordapp.\u200bcom"),
		legacyUrl.replace(token, `${token.slice(0, 34)}\u200b${token.slice(34)}`),
		underscoreUrl,
		underscoreUrl.replace(underscoreToken, `${underscoreToken.slice(0, 34)}\u200b${underscoreToken.slice(34)}`),
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
		underscoreUrl.replace(underscoreToken, underscoreToken.slice(1)),
		underscoreUrl.replace(underscoreToken, `${underscoreToken}_`),
		url.replace("/api/webhooks/", "/api/webhook/"),
		url.replace("https://", "http://"),
		`prefix${url}`,
		"Discord webhook setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens synthetic Discord authentication and MFA tokens without flagging near-misses", () => {
	const first = "A1b_".repeat(6);
	const middle = "cD9_-Z";
	const last = "QwErTy9_-".repeat(3);
	const authToken = `${first}.${middle}.${last}`;
	const mfaToken = `mfa.${"a1B_".repeat(21)}`;
	const obfuscatedTokens = [
		authToken.replace(`${first}.`, `${first}.\u200b`),
		mfaToken.replace("mfa.", "mfa.\u200b"),
	];

	for (const value of [authToken, mfaToken, ...obfuscatedTokens]) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		`${first.slice(1)}.${middle}.${last}`,
		`${first}.${middle.slice(1)}.${last}`,
		`${first}.${middle}.${last.slice(1)}`,
		`${authToken}x`,
		`x${authToken}`,
		`mfa.${"a1B_".repeat(20)}`,
		`mfa.${"a1B_".repeat(21)}A`,
		mfaToken.slice(1),
		`${mfaToken}x`,
		`x${mfaToken}`,
		"Discord bot authentication setup",
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

test("screens synthetic EasyPost API keys without flagging near-misses", () => {
	const keys = [
		`EZAK${"A1b2".repeat(13)}A1`,
		`EZTK${"C3d4".repeat(13)}C3`,
		`eztk${"E5f6".repeat(13)}E5`,
	];
	const obfuscatedKeys = [
		keys[0]!.replace("EZAK", "EZ\u200bAK"),
		keys[1]!.replace("C3d4".repeat(3), `C3d4\u200b${"C3d4".repeat(2)}`),
	];

	for (const key of [...keys, ...obfuscatedKeys, `${keys[0]}-production`]) {
		expect(hasSensitiveNamingContext(`rotate EasyPost API key ${key}`)).toBe(true);
		expect(hasSensitiveOutput(key)).toBe(true);
	}

	for (const nearMiss of [
		`EZAK${"A1b2".repeat(13)}A`,
		`EZTK${"C3d4".repeat(13)}C3A`,
		`prefixEZAK${"A1b2".repeat(13)}A1`,
		`EZAK${"A1b2".repeat(13)}A1suffix`,
		`EZXX${"A1b2".repeat(13)}A1`,
		"EasyPost API key setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens synthetic Airtable personal access tokens without flagging near-misses", () => {
	const token = `pat${"A1b2".repeat(3)}A1.${"a1b2".repeat(16)}`;
	const obfuscatedTokens = [
		token.replace("pat", "p\u200bat"),
		token.replace(".", "\u200b."),
		token.replace("a1b2".repeat(4), `a1b2\u200b${"a1b2".repeat(3)}`),
	];

	for (const value of [token, ...obfuscatedTokens]) {
		expect(hasSensitiveNamingContext(`review Airtable access ${value}`)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		`pat${"A1b2".repeat(3)}A.${"a1b2".repeat(16)}`,
		`pat${"A1b2".repeat(3)}A1.${"a1b2".repeat(15)}a1b`,
		`pat${"A1b2".repeat(3)}A1.${"a1b2".repeat(15)}a1bg`,
		`prefix${token}`,
		`${token}suffix`,
		"Airtable personal access token setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens synthetic ClickHouse Cloud API keys without flagging near-misses", () => {
	const key = `4b1d${"A1b2".repeat(9)}A1`;
	const obfuscatedKeys = [
		key.replace("4b1d", "4b\u200b1d"),
		key.replace("A1b2".repeat(4), `A1b2\u200b${"A1b2".repeat(3)}`),
	];

	for (const value of [key, ...obfuscatedKeys, key.toUpperCase()]) {
		expect(hasSensitiveNamingContext(`review ClickHouse access ${value}`)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		`4b1d${"A1b2".repeat(9)}A`,
		`4b1d${"A1b2".repeat(9)}A1B`,
		`4b1c${"A1b2".repeat(9)}A1`,
		key.replace("A1b2", "A1b!"),
		`prefix${key}`,
		`${key}suffix`,
		"ClickHouse API key setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens additional AWS access-key ID prefixes without flagging near-misses", () => {
	const keys = [
		`A3TA${"B".repeat(16)}`,
		`ABIA${"C".repeat(16)}`,
		`ACCA${"D".repeat(16)}`,
	];
	const obfuscatedKey = `${keys[0]!.slice(0, 10)}\u200b${keys[0]!.slice(10)}`;

	for (const key of [...keys, obfuscatedKey]) {
		expect(hasSensitiveNamingContext(`review AWS access ${key}`)).toBe(true);
		expect(hasSensitiveOutput(key)).toBe(true);
	}

	for (const nearMiss of [
		`ABIA${"C".repeat(15)}`,
		`ACCA${"D".repeat(17)}`,
		`ABIA${"C".repeat(15)}0`,
		`prefixABIA${"C".repeat(16)}`,
		`ACCA${"D".repeat(16)}x`,
		"AWS temporary access key configuration",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("requestNamingTitle screens sensitive context before model-registry access", async () => {
	const contextTexts = [
		"task: pi-tmux@example.invalid",
		`${"A1b_".repeat(6)}.${"cD9_-Z"}.${"QwErTy9_-".repeat(3)}`,
		`mfa.${"a1B_".repeat(21)}`,
	];
	const context = {
		get modelRegistry() {
			throw new Error("Sensitive context must be rejected before model-registry access");
		},
	} as unknown as ExtensionContext;

	for (const contextText of contextTexts) {
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
		expect((error as Error).message).not.toContain(contextText);
	}
});
