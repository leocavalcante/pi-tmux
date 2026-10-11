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

test("screens webhook and Discord auth credentials across retained-context boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const teamsGuid = "01234567-89ab-cdef-0123-456789abcdef";
	const teamsOtherGuid = "fedcba98-7654-3210-fedc-ba9876543210";
	const slackToken = `${"A1b2".repeat(10)}A1b`;
	const legacySlackToken = "C3d4".repeat(6);
	const discordToken = "D5e6".repeat(17);
	const discordAuthToken = `${"A1b_".repeat(6)}.cD9_-Z.${"QwErTy9_-".repeat(3)}`;
	const discordMfaToken = `mfa.${"a1B_".repeat(21)}`;
	const teamsToken = "a1b2c3d4".repeat(4);
	const values = [
		{ value: `whsec_${"F7g8".repeat(6)}`, secret: `whsec_${"F7g8".repeat(6)}` },
		{ value: `https://hooks.slack.com/services/${slackToken}`, secret: slackToken },
		{
			value: `https://hooks.slack.com/services/T00000000/B11111111/${legacySlackToken}`,
			secret: legacySlackToken,
		},
		{
			value: `https://discord.com/api/webhooks/123456789012345678/${discordToken}`,
			secret: discordToken,
		},
		{ value: discordAuthToken, secret: discordAuthToken },
		{ value: discordMfaToken, secret: discordMfaToken },
		{
			value: `https://tenant.webhook.office.com/webhookb2/${teamsGuid}@${teamsOtherGuid}/IncomingWebhook/${teamsToken}/${teamsGuid}`,
			secret: teamsToken,
		},
	];

	for (const { value, secret } of values) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
		const obfuscated = value.replace(secret, `${secret.slice(0, 10)}\u0000${secret.slice(10)}`);
		for (const candidate of [value, obfuscated]) {
			const secretPrefix = secret.slice(0, 10);
			const valueStart = prefixLength - 10 - candidate.indexOf(secretPrefix);
			const prompt = `${"x".repeat(valueStart - 1)} ${candidate} ${"y".repeat(1_200)}`;
			const context = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const summaryContent = `${"x".repeat(989)} ${values[5]!.value} y`;
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: summaryContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const historyValue = values[4]!;
	const historyValueStart = 990 - historyValue.value.indexOf(historyValue.secret);
	const historyContent = `${"x".repeat(historyValueStart - 1)} ${historyValue.value} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);

	// A Teams URL can straddle the omitted region while its 32-character secret
	// remains wholly omitted; the structural URL alone must not trigger a block.
	const teamsValue = values[6]!.value;
	const teamsSecretOffset = teamsValue.indexOf(teamsToken);
	const omittedSecretPromptStart = prefixLength + 5 - teamsSecretOffset;
	const omittedSecretPrompt = `${"x".repeat(omittedSecretPromptStart - 1)} ${teamsValue} ${"y".repeat(1_200)}`;
	expect(buildNamingRequestContext([], omittedSecretPrompt).hasSensitiveBoundary()).toBe(false);

	for (const nearMiss of [discordAuthToken.slice(0, -1), discordMfaToken.slice(0, -1)]) {
		const tokenStart = prefixLength - 10;
		const nearMissPrompt = `${"x".repeat(tokenStart - 1)} ${nearMiss} ${"y".repeat(1_200)}`;
		expect(buildNamingRequestContext([], nearMissPrompt).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens Telegram, Vault, Notion, and Supabase tokens across truncation", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const telegramSecret = `A${"a".repeat(34)}`;
	const telegramToken = `123456789:${telegramSecret}`;
	const vaultServiceToken = `hvs.${"V".repeat(24)}`;
	const vaultBatchToken = `hvb.${"B".repeat(24)}`;
	const notionToken = `ntn_${"1".repeat(11)}${"a".repeat(35)}`;
	const supabaseToken = `sb_secret_${"S".repeat(32)}`;
	const values = [
		{ value: telegramToken, secret: telegramSecret },
		{ value: vaultServiceToken, secret: vaultServiceToken },
		{ value: vaultBatchToken, secret: vaultBatchToken },
		{ value: notionToken, secret: notionToken },
		{ value: supabaseToken, secret: supabaseToken },
	];

	for (const { value, secret } of values) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
		const obfuscated = value.replace(secret, `${secret.slice(0, 10)}\u0000${secret.slice(10)}`);
		for (const candidate of [value, obfuscated]) {
			const valueStart = prefixLength - 10 - candidate.indexOf(secret.slice(0, 10));
			const prompt = `${"x".repeat(valueStart - 1)} ${candidate} ${"y".repeat(1_200)}`;
			const context = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const historyValue = values[3]!;
	const historyValueStart = 990 - historyValue.value.indexOf(historyValue.secret);
	const historyContent = `${"x".repeat(historyValueStart - 1)} ${historyValue.value} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);

	const summaryContent = `${"x".repeat(989)} ${supabaseToken} y`;
	const summary = buildNamingRequestContext([{ role: "compactionSummary", summary: summaryContent }] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	// The Telegram bot ID may straddle a boundary while the API secret remains omitted.
	const telegramValueStart = prefixLength + 5 - telegramToken.indexOf(telegramSecret);
	const telegramIdOnlyPrompt = `${"x".repeat(telegramValueStart - 1)} ${telegramToken} ${"y".repeat(1_200)}`;
	expect(buildNamingRequestContext([], telegramIdOnlyPrompt).hasSensitiveBoundary()).toBe(false);

	const nearMisses = [
		`123456789:A${"a".repeat(33)}`,
		`hvs.${"V".repeat(23)}`,
		`hvb.${"B".repeat(25)}`,
		`ntn_${"1".repeat(11)}${"a".repeat(34)}`,
		`sb_secret_${"S".repeat(31)}`,
	];
	for (const nearMiss of nearMisses) {
		const tokenStart = prefixLength - 10;
		const prompt = `${"x".repeat(tokenStart - 1)} ${nearMiss} ${"y".repeat(1_200)}`;
		expect(buildNamingRequestContext([], prompt).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens deployment and commerce tokens across truncation", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const atlassianToken = `ATATT3${"a".repeat(183)}_-=`;
	const shopifyTokens = ["shpat_", "shpca_", "shppa_", "shpss_"].map((prefix) => `${prefix}${"a".repeat(32)}`);
	const shippoTokens = ["live", "test"].map((mode) => `shippo_${mode}_${"a".repeat(40)}`);
	const postmanToken = `PMAK-${"a".repeat(24)}-${"b".repeat(34)}`;
	const pulumiToken = `pul-${"a".repeat(40)}`;
	const digitalOceanTokens = ["doo", "dop", "dor"].map((prefix) => `${prefix}_v1_${"a".repeat(64)}`);
	const prefectToken = `pnu_${"A1b2".repeat(9)}`;
	const octopusApiKey = `API-${"A1B2".repeat(6)}A1`;
	const values = [
		atlassianToken, ...shopifyTokens, ...shippoTokens, postmanToken,
		pulumiToken, ...digitalOceanTokens, prefectToken, octopusApiKey,
	];

	for (const value of values) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
		const obfuscated = value.slice(0, 10) + "\u200b" + value.slice(10);
		for (const candidate of [value, obfuscated]) {
			const valueStart = prefixLength - 10;
			const prompt = `${"x".repeat(valueStart - 1)} ${candidate} ${"y".repeat(1_200)}`;
			const context = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const historyContent = `${"x".repeat(989)} ${postmanToken} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);

	const summaryContent = `${"x".repeat(989)} ${pulumiToken} y`;
	const summary = buildNamingRequestContext([{ role: "compactionSummary", summary: summaryContent }] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const nearMisses = [
		`ATATT3${"a".repeat(182)}_-=`,
		`shpat_${"a".repeat(31)}`,
		`shippo_live_${"a".repeat(39)}`,
		`PMAK-${"a".repeat(23)}-${"b".repeat(34)}`,
		`pul-${"a".repeat(39)}`,
		`doo_v1_${"a".repeat(63)}`,
		`pnu_${"A1b2".repeat(8)}A1b`,
		`API-${"A1B2".repeat(6)}A`,
	];
	for (const nearMiss of nearMisses) {
		const tokenStart = prefixLength - 10;
		const prompt = `${"x".repeat(tokenStart - 1)} ${nearMiss} ${"y".repeat(1_200)}`;
		expect(buildNamingRequestContext([], prompt).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens Grafana, Doppler, and Sentry tokens across truncation", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const grafanaApiKey = `eyJrIjoi${"A".repeat(70)}`;
	const grafanaCloudToken = `glc_${"A".repeat(400)}`;
	const serviceBody = "aB3cD5eF7gH9jK2mN4pQ6rS8tU1vW0x".repeat(2).slice(0, 32);
	const grafanaServiceToken = `glsa_${serviceBody}_A1B2C3D4`;
	const dopplerToken = `dp.pt.${"A".repeat(43)}`;
	const sentryUserToken = `sntryu_${"a".repeat(64)}`;
	const values = [grafanaApiKey, grafanaCloudToken, grafanaServiceToken, dopplerToken, sentryUserToken];

	for (const value of values) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
		const obfuscated = value.slice(0, 10) + "\u200b" + value.slice(10);
		for (const candidate of [value, obfuscated]) {
			const valueStart = prefixLength - 10;
			const prompt = `${"x".repeat(valueStart - 1)} ${candidate} ${"y".repeat(1_200)}`;
			const context = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const historyValue = sentryUserToken;
	const historyValueStart = 990;
	const historyContent = `${"x".repeat(historyValueStart - 1)} ${historyValue} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);

	const summaryContent = `${"x".repeat(989)} ${dopplerToken} y`;
	const summary = buildNamingRequestContext([{ role: "compactionSummary", summary: summaryContent }] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const nearMisses = [
		`eyJrIjoi${"A".repeat(69)}`,
		`glc_${"A".repeat(31)}`,
		`glsa_${serviceBody.slice(0, 31)}_A1B2C3D4`,
		`dp.pt.${"A".repeat(42)}`,
		`sntryu_${"a".repeat(63)}`,
	];
	for (const nearMiss of nearMisses) {
		const tokenStart = prefixLength - 10;
		const prompt = `${"x".repeat(tokenStart - 1)} ${nearMiss} ${"y".repeat(1_200)}`;
		expect(buildNamingRequestContext([], prompt).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens additional supported fixed-format tokens across retained-context boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const tokens = [
		`NRAK-${"A1b2".repeat(6)}abc`,
		`HRKU-AA${"A1_b".repeat(14)}AB`,
		`AKCp${"A1b2".repeat(17)}A`,
		`cmVmd${"C1d2".repeat(14)}AbC`,
		`dt0c01.${"A1b2".repeat(6)}.${"C3d4".repeat(16)}`,
		`fo1_${"A1_b".repeat(10)}ABC`,
	];

	for (const token of tokens) {
		expect(hasSensitiveNamingContext(`review the integration ${token}`)).toBe(true);
		expect(hasSensitiveOutput(token)).toBe(true);
		for (const value of [token, `${token.slice(0, 10)}\u0000${token.slice(10)}`]) {
			const tokenStart = prefixLength - 10;
			const prompt = `${"x".repeat(tokenStart - 1)} ${value} ${"y".repeat(1_200)}`;
			const promptContext = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(promptContext.text)).toBe(false);
			expect(promptContext.hasSensitiveBoundary()).toBe(true);
		}
	}

	const historyContent = `${"x".repeat(989)} ${tokens[0]} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);

	const summaryContent = `${"x".repeat(989)} ${tokens[2]} y`;
	const summary = buildNamingRequestContext([{ role: "compactionSummary", summary: summaryContent }] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const invalidNewRelicToken = `NRAK-${"A1b2".repeat(6)}ab`;
	const invalidPrompt = `${"x".repeat(prefixLength - 11)} ${invalidNewRelicToken} ${"y".repeat(1_200)}`;
	expect(buildNamingRequestContext([], invalidPrompt).hasSensitiveBoundary()).toBe(false);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)} ${tokens[5]} ${"y".repeat(1_200)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
});

test("screens supported fixed-format tokens across retained-context boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const tokens = [
		`rubygems_${"a".repeat(48)}`,
		`CLOJARS_${"A".repeat(60)}`,
		`tfp_${"A".repeat(59)}`,
	];

	for (const token of tokens) {
		expect(hasSensitiveNamingContext(`review the integration ${token}`)).toBe(true);
		expect(hasSensitiveOutput(token)).toBe(true);
		for (const value of [token, `${token.slice(0, 10)}\u0000${token.slice(10)}`]) {
			const tokenStart = prefixLength - 10;
			const prompt = `${"x".repeat(tokenStart - 1)} ${value} ${"y".repeat(1_200)}`;
			const promptContext = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(promptContext.text)).toBe(false);
			expect(promptContext.hasSensitiveBoundary()).toBe(true);
			expect(promptContext.text).toBe(buildNamingContext([], prompt));
		}
	}

	const historyContent = `${"x".repeat(989)} ${tokens[0]} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);

	const summaryContent = `${"x".repeat(989)} ${tokens[1]} y`;
	const summary = buildNamingRequestContext([{ role: "compactionSummary", summary: summaryContent }] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const invalidToken = `rubygems_${"a".repeat(47)}`;
	const invalidPrompt = `${"x".repeat(prefixLength - 11)} ${invalidToken} ${"y".repeat(1_200)}`;
	expect(buildNamingRequestContext([], invalidPrompt).hasSensitiveBoundary()).toBe(false);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)} ${tokens[2]} ${"y".repeat(1_200)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
});

test("screens LangSmith personal and service API keys across retained-context boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const tokens = ["lsv2_pt_", "LSV2_SK_"].map((prefix) =>
		`${prefix}${"a1b2".repeat(8)}_${"c3d4a1b2c3"}`);

	for (const token of tokens) {
		expect(hasSensitiveNamingContext(`configure LangSmith ${token}`)).toBe(true);
		expect(hasSensitiveOutput(token)).toBe(true);
		const obfuscated = `${token.slice(0, 8)}\u0000${token.slice(8)}`;
		for (const value of [token, obfuscated]) {
			expect(hasSensitiveNamingContext(value)).toBe(true);
			expect(hasSensitiveOutput(value)).toBe(true);
			const tokenStart = prefixLength - 10;
			const prompt = `${"x".repeat(tokenStart - 1)} ${value} ${"y".repeat(1_200)}`;
			const context = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const nearMisses = [
		`lsv2_pt_${"a".repeat(31)}_${"c".repeat(10)}`,
		`lsv2_sk_${"a".repeat(32)}_${"c".repeat(9)}`,
		`lsv2_pt_${"g".repeat(32)}_${"c".repeat(10)}`,
		`prefix${tokens[0]}`,
		`${tokens[1]}x`,
	];
	for (const nearMiss of nearMisses) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens Tavily API keys across retained-context boundaries without flagging near-misses", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const prefixes = ["tvly-", "tvly-dev-", "tvly-prod-"];
	const tokens = prefixes.map((prefix) => ({
		prefix,
		value: `${prefix}${"a1B2c3D4".repeat(3)}`,
	}));

	for (const { prefix, value } of tokens) {
		const obfuscated = `${value.slice(0, prefix.length)}\u200b${value.slice(prefix.length)}`;
		for (const candidate of [value, obfuscated]) {
			expect(hasSensitiveNamingContext(candidate)).toBe(true);
			expect(hasSensitiveOutput(candidate)).toBe(true);
			const tokenStart = prefixLength - 10;
			const prompt = `${"x".repeat(tokenStart - 1)} ${candidate} ${"y".repeat(1_200)}`;
			const context = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const nearMisses = [
		`tvly-${"a".repeat(15)}`,
		`tvly-dev-${"a".repeat(15)}`,
		`tvly-qa-${"a".repeat(32)}`,
		`notvly-${"a".repeat(32)}`,
		`${tokens[0]!.value}_suffix`,
	];
	for (const nearMiss of nearMisses) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens Jina AI API keys across retained-context boundaries without flagging near-misses", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const body = "a1B2c3D4e5F6".repeat(5);
	const tokens = [`jina_${body}`, `JINA_${body}`];

	for (const token of tokens) {
		const obfuscated = `${token.slice(0, 2)}\u200b${token.slice(2)}`;
		for (const candidate of [token, obfuscated]) {
			expect(hasSensitiveNamingContext(candidate)).toBe(true);
			expect(hasSensitiveOutput(candidate)).toBe(true);
			const tokenStart = prefixLength - 10;
			const prompt = `${"x".repeat(tokenStart - 1)} ${candidate} ${"y".repeat(1_200)}`;
			const context = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const nearMisses = [
		`jina_${body.slice(1)}`,
		`jina_${body}a`,
		`jina_${`${body.slice(0, 30)}!${body.slice(31)}`}`,
		`x${tokens[0]}`,
		`${tokens[0]}_suffix`,
	];
	for (const nearMiss of nearMisses) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens Browserbase live/test API keys across retained-context boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const suffix = "a1B2_c3D4-".repeat(3);
	const tokens = ["bb_live_", "bb_test_", "BB_LIVE_"].map((prefix) => `${prefix}${suffix}`);

	for (const token of tokens) {
		const obfuscated = `${token.slice(0, 1)}\u200b${token.slice(1)}`;
		for (const candidate of [token, obfuscated]) {
			expect(hasSensitiveNamingContext(candidate)).toBe(true);
			expect(hasSensitiveOutput(candidate)).toBe(true);
			const tokenStart = prefixLength - 10;
			const prompt = `${"x".repeat(tokenStart - 1)} ${candidate} ${"y".repeat(1_200)}`;
			const context = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const nearMisses = [
		`bb_live_${"a".repeat(19)}`,
		`bb_dev_${"a".repeat(24)}`,
		`notbb_live_${"a".repeat(24)}`,
		`bb_live_${"a".repeat(10)}.${"b".repeat(10)}`,
	];
	for (const nearMiss of nearMisses) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens Firecrawl API keys across retained-context boundaries without flagging near-misses", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const tokens = [`fc-${"a1B2c3D4".repeat(3)}`, `FC-${"A1b2C3d4".repeat(3)}`];

	for (const token of tokens) {
		const obfuscated = `${token.slice(0, 2)}\u200b${token.slice(2)}`;
		for (const candidate of [token, obfuscated]) {
			expect(hasSensitiveNamingContext(candidate)).toBe(true);
			expect(hasSensitiveOutput(candidate)).toBe(true);
			const tokenStart = prefixLength - 10;
			const prompt = `${"x".repeat(tokenStart - 1)} ${candidate} ${"y".repeat(1_200)}`;
			const context = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const nearMisses = [
		`fc-${"a".repeat(19)}`,
		`notfc-${"a".repeat(24)}`,
		`fc-${"a".repeat(24)}_suffix`,
		"00000000-0000-0000-0000-fc-0123456789ab",
	];
	for (const nearMiss of nearMisses) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

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

test("screens long 1Password tokens across prompt truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const token = `ops_eyJ${"Aa0+/".repeat(50)}`;
	const makePrompt = (value: string) => {
		const tokenStart = prefixLength - 20;
		return `${"x".repeat(tokenStart - 1)} ${value} ${"y".repeat(1_300)}`;
	};
	const context = buildNamingRequestContext([], makePrompt(token));

	expect(context.text).not.toContain(token);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);

	const nearMiss = `ops_eyJ${"Aa0+/".repeat(49)}Aa0+`;
	expect(buildNamingRequestContext([], makePrompt(nearMiss)).hasSensitiveBoundary()).toBe(false);
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

test("screens labeled API credentials across retained-context truncation boundaries", () => {
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

	const cloudflareApiKey = "a1b2".repeat(10);
	const cloudflareLabel = " Cloudflare API key: ";
	const cloudflarePrompt = `${"x".repeat(prefixTokenStart - cloudflareLabel.length)}${cloudflareLabel}${cloudflareApiKey} ${"x".repeat(1_200)}`;
	const cloudflareContext = buildNamingRequestContext([], cloudflarePrompt);
	expect(hasSensitiveNamingContext(cloudflareContext.text)).toBe(false);
	expect(cloudflareContext.hasSensitiveBoundary()).toBe(true);
	expect(cloudflareContext.text).toBe(buildNamingContext([], cloudflarePrompt));

	const cloudflareGlobalKey = "a".repeat(37);
	const globalLabel = " Cloudflare global key: ";
	const globalPrompt = `${"x".repeat(prefixTokenStart - globalLabel.length)}${globalLabel}${cloudflareGlobalKey} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], globalPrompt).hasSensitiveBoundary()).toBe(true);

	const datadogKey = "A1b2".repeat(10);
	const datadogLabel = " Datadog: ";
	const mailgunToken = `key-${"a1b2".repeat(8)}`;
	const mailgunLabel = " Mailgun: ";
	const railwayToken = "11111111-2222-4333-8444-555555555555";
	const railwayLabel = " Railway: ";
	const additionalLabeledCredentials = [
		{ label: datadogLabel, token: datadogKey },
		{ label: mailgunLabel, token: mailgunToken },
		{ label: railwayLabel, token: railwayToken },
	];
	for (const { label, token: credential } of additionalLabeledCredentials) {
		const prompt = `${"x".repeat(prefixTokenStart - label.length)}${label}${credential} ${"x".repeat(1_200)}`;
		const context = buildNamingRequestContext([], prompt);
		expect(hasSensitiveNamingContext(context.text)).toBe(false);
		expect(context.hasSensitiveBoundary()).toBe(true);
		expect(context.text).toBe(buildNamingContext([], prompt));
	}
	const obfuscatedDatadogPrompt = `${"x".repeat(prefixTokenStart - datadogLabel.length)}${datadogLabel}${datadogKey.slice(0, 4)}\u200b${datadogKey.slice(4)} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedDatadogPrompt).hasSensitiveBoundary()).toBe(true);
	const obfuscatedRailwayPrompt = `${"x".repeat(prefixTokenStart - railwayLabel.length)}${railwayLabel}${railwayToken.slice(0, 8)}\u0000${railwayToken.slice(8)} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedRailwayPrompt).hasSensitiveBoundary()).toBe(true);
	for (const { label, token: invalidCredential } of [
		{ label: datadogLabel, token: datadogKey.slice(1) },
		{ label: datadogLabel, token: `${datadogKey}A` },
		{ label: mailgunLabel, token: mailgunToken.slice(1) },
		{ label: mailgunLabel, token: `${mailgunToken}A` },
		{ label: railwayLabel, token: railwayToken.replace("-", "_") },
	]) {
		const prompt = `${"x".repeat(prefixTokenStart - label.length)}${label}${invalidCredential} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], prompt).hasSensitiveBoundary()).toBe(false);
	}

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixStart = promptLength - suffixLength;
	const suffixTokenStart = suffixStart - 10;
	const suffixPrompt = `${"x".repeat(suffixTokenStart - 9)} Vercel: ${token} ${"y".repeat(promptLength - suffixTokenStart - 25)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);
	expect(suffixContext.text).toBe(buildNamingContext([], suffixPrompt));
	const railwaySuffixPrompt = `${"x".repeat(suffixTokenStart - railwayLabel.length)}${railwayLabel}${railwayToken} ${"y".repeat(promptLength - suffixTokenStart - railwayToken.length - 1)}`;
	const railwaySuffixContext = buildNamingRequestContext([], railwaySuffixPrompt);
	expect(hasSensitiveNamingContext(railwaySuffixContext.text)).toBe(false);
	expect(railwaySuffixContext.hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(981)} Vercel: ${token} y`;
	const historyContext = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(historyContext.text)).toBe(false);
	expect(historyContext.hasSensitiveBoundary()).toBe(true);

	const summaryContent = `${"x".repeat(981)} Vercel: ${token} y`;
	const summaryContext = buildNamingRequestContext([{ role: "compactionSummary", summary: summaryContent }] as any);
	expect(hasSensitiveNamingContext(summaryContext.text)).toBe(false);
	expect(summaryContext.hasSensitiveBoundary()).toBe(true);

	const cloudflareHistoryContent = `${"x".repeat(960)}${cloudflareLabel}${cloudflareApiKey} y`;
	const cloudflareHistory = buildNamingRequestContext([{ role: "user", content: cloudflareHistoryContent }] as any);
	expect(hasSensitiveNamingContext(cloudflareHistory.text)).toBe(false);
	expect(cloudflareHistory.hasSensitiveBoundary()).toBe(true);
	const cloudflareSummary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: cloudflareHistoryContent },
	] as any);
	expect(hasSensitiveNamingContext(cloudflareSummary.text)).toBe(false);
	expect(cloudflareSummary.hasSensitiveBoundary()).toBe(true);
	const datadogHistoryContent = `${"x".repeat(960)}${datadogLabel}${datadogKey} y`;
	const datadogHistory = buildNamingRequestContext([{ role: "user", content: datadogHistoryContent }] as any);
	expect(hasSensitiveNamingContext(datadogHistory.text)).toBe(false);
	expect(datadogHistory.hasSensitiveBoundary()).toBe(true);
	const mailgunSummaryContent = `${"x".repeat(960)}${mailgunLabel}${mailgunToken} y`;
	const mailgunSummary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: mailgunSummaryContent },
	] as any);
	expect(hasSensitiveNamingContext(mailgunSummary.text)).toBe(false);
	expect(mailgunSummary.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)} Vercel: ${token} ${"y".repeat(3_000)}`;
	const omittedContext = buildNamingRequestContext([], omittedPrompt);
	expect(hasSensitiveNamingContext(omittedContext.text)).toBe(false);
	expect(omittedContext.hasSensitiveBoundary()).toBe(false);
	const omittedCloudflarePrompt = `${"x".repeat(prefixLength + 20)}${cloudflareLabel}${cloudflareApiKey} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedCloudflarePrompt).hasSensitiveBoundary()).toBe(false);
	for (const { label, token: credential } of additionalLabeledCredentials) {
		const omittedCredentialPrompt = `${"x".repeat(prefixLength + 20)}${label}${credential} ${"y".repeat(3_000)}`;
		expect(buildNamingRequestContext([], omittedCredentialPrompt).hasSensitiveBoundary()).toBe(false);
	}
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

test("screens Docker registry auth fields only when they encode user/password pairs", () => {
	const encoded = Buffer.from("synthetic-user:synthetic-password").toString("base64");
	const candidates = [
		{ value: `"auth": "${encoded}"`, tokenOffset: `"auth": "`.length },
		{
			value: `a\u200buth: ${encoded.slice(0, 10)}\u0000${encoded.slice(10)}`,
			tokenOffset: "a\u200buth: ".length,
		},
	];
	for (const { value } of candidates) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	const nearMisses = [
		`"auth": "${Buffer.from("registry login").toString("base64")}"`,
		`auth=${Buffer.from("ordinary configuration").toString("base64")}`,
		"auth=not-a-base64-value!",
	];
	for (const value of nearMisses) {
		expect(hasSensitiveNamingContext(value)).toBe(false);
		expect(hasSensitiveOutput(value)).toBe(false);
	}

	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const promptLength = 3_000;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const tokenStarts = [prefixLength - 10, suffixStart - 10];
	const promptWithCredentialAt = (candidate: typeof candidates[number], tokenStart: number) => {
		const prefix = `${"x".repeat(tokenStart - candidate.tokenOffset - 1)} `;
		const separator = "\n";
		const prompt = `${prefix}${candidate.value}${separator}${"y".repeat(promptLength - prefix.length - candidate.value.length - separator.length)}`;
		expect(prompt).toHaveLength(promptLength);
		return prompt;
	};

	for (const candidate of candidates) {
		for (const tokenStart of tokenStarts) {
			const context = buildNamingRequestContext([], promptWithCredentialAt(candidate, tokenStart));
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}
	const ordinaryAuth = { value: `auth: ${Buffer.from("registry login").toString("base64")}`, tokenOffset: "auth: ".length };
	for (const tokenStart of tokenStarts) {
		const context = buildNamingRequestContext([], promptWithCredentialAt(ordinaryAuth, tokenStart));
		expect(context.hasSensitiveBoundary()).toBe(false);
	}

	const historyContent = `${"x".repeat(981)}${candidates[0]!.value} trailing text`;
	for (const input of [
		[{ role: "user", content: historyContent }],
		[{ role: "compactionSummary", summary: historyContent }],
	] as any[]) {
		const context = buildNamingRequestContext(input);
		expect(hasSensitiveNamingContext(context.text)).toBe(false);
		expect(context.hasSensitiveBoundary()).toBe(true);
	}
});

test("screens npm .npmrc _auth values across retained-context truncation boundaries", () => {
	const encoded = Buffer.from("synthetic-user:synthetic-password").toString("base64");
	const candidates = [
		{
			value: `//registry.npmjs.org/:_auth=${encoded}`,
			tokenOffset: `//registry.npmjs.org/:_auth=`.length,
		},
		{
			value: `//registry.npmjs.org/:_au\u200bth=${encoded.slice(0, 10)}\u0000${encoded.slice(10)}`,
			tokenOffset: `//registry.npmjs.org/:_au\u200bth=`.length,
		},
	];
	for (const { value } of candidates) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	const nearMisses = [
		`//registry.npmjs.org/:_auth=${Buffer.from("ordinary registry config").toString("base64")}`,
		"//registry.npmjs.org/:_auth=not-a-base64-value!",
	];
	for (const value of nearMisses) {
		expect(hasSensitiveNamingContext(value)).toBe(false);
		expect(hasSensitiveOutput(value)).toBe(false);
	}

	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const promptLength = 3_000;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const tokenStarts = [prefixLength - 10, suffixStart - 10];
	const promptWithCredentialAt = (candidate: typeof candidates[number], tokenStart: number) => {
		const prefix = `${"x".repeat(tokenStart - candidate.tokenOffset - 1)} `;
		const separator = "\n";
		const prompt = `${prefix}${candidate.value}${separator}${"y".repeat(promptLength - prefix.length - candidate.value.length - separator.length)}`;
		expect(prompt).toHaveLength(promptLength);
		return prompt;
	};

	for (const candidate of candidates) {
		for (const tokenStart of tokenStarts) {
			const context = buildNamingRequestContext([], promptWithCredentialAt(candidate, tokenStart));
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const historyContent = `${"x".repeat(990 - candidates[0]!.tokenOffset)}${candidates[0]!.value} trailing text`;
	for (const input of [
		[{ role: "user", content: historyContent }],
		[{ role: "compactionSummary", summary: historyContent }],
	] as any[]) {
		const context = buildNamingRequestContext(input);
		expect(hasSensitiveNamingContext(context.text)).toBe(false);
		expect(context.hasSensitiveBoundary()).toBe(true);
	}
});

test("screens short Basic Authorization and npm password values across truncation", () => {
	const npmPassword = `//registry.npmjs.org/:_password=${Buffer.from("pw1").toString("base64")}`;
	const basic = `Authorization: Basic ${Buffer.from("u:p").toString("base64")}`;
	const obfuscatedNpmPassword = npmPassword.replace("_password", "_pass\u200bword").replace("cHcx", "cH\u0000cx");
	const candidates = [
		{ value: npmPassword, tokenOffset: npmPassword.indexOf("=") + 1 },
		{ value: obfuscatedNpmPassword, tokenOffset: obfuscatedNpmPassword.indexOf("=") + 1 },
		{ value: basic, tokenOffset: "Authorization: Basic ".length },
		{
			value: `Proxy-Authorization: Basic ${Buffer.from("u:p").toString("base64")}`,
			tokenOffset: "Proxy-Authorization: Basic ".length,
		},
		{
			value: `Authorization: B a s i c ${Buffer.from("u:p").toString("base64")}`,
			tokenOffset: `Authorization: B a s i c `.length,
		},
		{
			value: `Autho\u200brization: Ba\u200bsic dT\u0000pw`,
			tokenOffset: `Autho\u200brization: Ba\u200bsic `.length,
		},
		{
			value: `Authorization: |-\n  Basic ${Buffer.from("u:p").toString("base64")}`,
			tokenOffset: `Authorization: |-\n  Basic `.length,
		},
		{
			value: `Proxy-Authorization: >-\n  Basic\n  ${Buffer.from("p:w").toString("base64")}`,
			tokenOffset: `Proxy-Authorization: >-\n  Basic\n  `.length,
		},
	];
	for (const { value } of candidates) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	const nearMisses = [
		`//registry.npmjs.org/:_password=${Buffer.from("example").toString("base64")}`,
		"//registry.npmjs.org/:_password=a!",
		`Authorization: Basic ${Buffer.from("no-pair").toString("base64")}`,
		`Authorization: B a s i c ordinary auth prose`,
		`Authorization: |-\n  Basic ${Buffer.from("no-pair").toString("base64")}`,
		`Authorization: |-\n  Basic ${Buffer.from("u:p").toString("base64")}\n\n  x`,
	];
	for (const value of nearMisses) {
		expect(hasSensitiveNamingContext(value)).toBe(false);
		expect(hasSensitiveOutput(value)).toBe(false);
	}

	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const promptLength = 3_000;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const promptWithCredentialAt = (candidate: typeof candidates[number], tokenStart: number) => {
		const prefix = `${"x".repeat(tokenStart - candidate.tokenOffset - 1)} `;
		const separator = candidate.value.includes("\n") ? "\n" : " ";
		const prompt = `${prefix}${candidate.value}${separator}${"y".repeat(promptLength - prefix.length - candidate.value.length - separator.length)}`;
		expect(prompt).toHaveLength(promptLength);
		return prompt;
	};

	for (const candidate of candidates) {
		for (const tokenStart of [prefixLength - 2, suffixStart - 2]) {
			const context = buildNamingRequestContext([], promptWithCredentialAt(candidate, tokenStart));
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
		const separator = candidate.value.includes("\n") ? "\n" : " ";
		const historyContent = `${"x".repeat(997 - candidate.tokenOffset)} ${candidate.value}${separator}trailing text`;
		for (const input of [
			[{ role: "user", content: historyContent }],
			[{ role: "compactionSummary", summary: historyContent }],
		] as any[]) {
			const context = buildNamingRequestContext(input);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const placeholder = `//registry.npmjs.org/:_password=${Buffer.from("example").toString("base64")}`;
	for (const tokenStart of [prefixLength - 2, suffixStart - 2]) {
		const context = buildNamingRequestContext([], promptWithCredentialAt({
			value: placeholder, tokenOffset: placeholder.indexOf("=") + 1,
		}, tokenStart));
		expect(context.hasSensitiveBoundary()).toBe(false);
	}
	const basicNearMisses = [
		{
			value: `Authorization: Basic ${Buffer.from("no-pair").toString("base64")}`,
			tokenOffset: "Authorization: Basic ".length,
		},
		{
			value: `Authorization: |-\n  Basic ${Buffer.from("no-pair").toString("base64")}`,
			tokenOffset: `Authorization: |-\n  Basic `.length,
		},
		{
			value: `Authorization: |-\n  Basic ${Buffer.from("u:p").toString("base64")}\n\n  x`,
			tokenOffset: `Authorization: |-\n  Basic `.length,
		},
	];
	for (const candidate of basicNearMisses) {
		for (const tokenStart of [prefixLength - 2, suffixStart - 2]) {
			const context = buildNamingRequestContext([], promptWithCredentialAt(candidate, tokenStart));
			expect(context.hasSensitiveBoundary()).toBe(false);
		}
	}
});

test("screens whitespace-obfuscated Authorization and proxy header names with valid Basic pairs", () => {
	const encoded = Buffer.from("synthetic-user:synthetic-password").toString("base64");
	for (const value of [
		`Author ization: Basic ${encoded}`,
		`Proxy-Author ization: Basic ${encoded}`,
		`Pro xy-Authorization: Basic ${encoded}`,
		`Prox y-Authorization: Basic ${encoded}`,
	]) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const promptLength = 3_000;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const promptAtBoundary = (value: string, headerStartOffset: number) => {
		const headerStart = suffixStart - headerStartOffset;
		const prefix = `${"x".repeat(headerStart - 1)} `;
		const padding = ` ${"x".repeat(promptLength - prefix.length - value.length - 1)}`;
		return `${prefix}${value}${padding}`;
	};

	const credential = `Pro xy-Authorization: Basic ${encoded}`;
	const context = buildNamingRequestContext([], promptAtBoundary(credential, "Pro ".length));
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);

	const nearMiss = "Pro xy-Authorization: Basic ordinary auth prose";
	expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
	expect(hasSensitiveOutput(nearMiss)).toBe(false);
	expect(buildNamingRequestContext([], promptAtBoundary(nearMiss, "Pro ".length)).hasSensitiveBoundary()).toBe(false);
});

test("screens whitespace-split Basic authorization labels across suffix truncation", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const promptLength = 3_000;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const encoded = Buffer.from("synthetic-user:synthetic-password").toString("base64");
	const promptAtBoundary = (value: string) => {
		const schemeStart = suffixStart - 3;
		const prefix = `${"x".repeat(schemeStart - "Authorization: ".length - 1)} `;
		const padding = ` ${"x".repeat(promptLength - prefix.length - value.length - 1)}`;
		return `${prefix}${value}${padding}`;
	};

	const credential = `Authorization: B a s i c ${encoded}`;
	const context = buildNamingRequestContext([], promptAtBoundary(credential));
	expect(hasSensitiveNamingContext(credential)).toBe(true);
	expect(hasSensitiveOutput(credential)).toBe(true);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);

	const nearMiss = buildNamingRequestContext([], promptAtBoundary("Authorization: B a s i c ordinary auth prose"));
	expect(nearMiss.hasSensitiveBoundary()).toBe(false);
});

test("screens generic sk/rk API keys across prompt truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const promptLength = 3_000;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const tokens = [
		`sk-${"A".repeat(32)}`,
		`rk-${"B".repeat(16)}_stage-1`,
		`sk-${"C".repeat(8)}\u200b${"C".repeat(16)}`,
	];
	const promptWithTokenAt = (token: string, tokenStart: number) => {
		const prefix = `${"x".repeat(tokenStart - 1)} `;
		return `${prefix}${token} ${"y".repeat(promptLength - prefix.length - token.length - 1)}`;
	};
	for (const token of tokens) {
		expect(hasSensitiveNamingContext(token)).toBe(true);
		for (const tokenStart of [prefixLength - 2, suffixStart - 2]) {
			const context = buildNamingRequestContext([], promptWithTokenAt(token, tokenStart));
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const nearMisses = [`csk-${"D".repeat(24)}`, `sk-${"E".repeat(15)}`];
	for (const token of nearMisses) {
		expect(hasSensitiveNamingContext(token)).toBe(false);
		for (const tokenStart of [prefixLength - 2, suffixStart - 2]) {
			const context = buildNamingRequestContext([], promptWithTokenAt(token, tokenStart));
			expect(context.hasSensitiveBoundary()).toBe(false);
		}
	}
});

test("screens whitespace-obfuscated fixed-format credentials across truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const promptLength = 3_000;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const whitespaceObfuscatedToken = `neon_api_key_${"N".repeat(16)} ${"N".repeat(16)}`;
	const promptWithTokenAt = (candidate: string, tokenStart: number) => {
		const prefix = `${"x".repeat(tokenStart - 1)} `;
		return `${prefix}${candidate} ${"y".repeat(promptLength - prefix.length - candidate.length - 1)}`;
	};

	expect(hasSensitiveNamingContext(whitespaceObfuscatedToken)).toBe(true);
	for (const tokenStart of [prefixLength - 34, suffixStart - 5]) {
		const context = buildNamingRequestContext([], promptWithTokenAt(whitespaceObfuscatedToken, tokenStart));
		expect(hasSensitiveNamingContext(context.text)).toBe(false);
		expect(context.hasSensitiveBoundary()).toBe(true);
	}

	const historyContent = `${"x".repeat(968)} ${whitespaceObfuscatedToken} y`;
	for (const context of [
		buildNamingRequestContext([{ role: "user", content: historyContent }] as any),
		buildNamingRequestContext([{ role: "compactionSummary", summary: historyContent }] as any),
	]) {
		expect(hasSensitiveNamingContext(context.text)).toBe(false);
		expect(context.hasSensitiveBoundary()).toBe(true);
	}

});

test("generic sk/rk matching does not compact task-based prose into API keys", () => {
	for (const prompt of [
		"task-based development",
		"task-based development with tests",
		"task-based\ndevelopment",
		"work-based development",
	]) {
		expect(hasSensitiveNamingContext(prompt)).toBe(false);
		expect(hasSensitiveOutput(prompt)).toBe(false);
	}

	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const promptLength = 3_000;
	const tokenStart = Math.ceil(retainedLength / 2) - 2;
	const prefix = `${"x".repeat(tokenStart - 1)} `;
	const prompt = `${prefix}task-based development ${"y".repeat(promptLength - prefix.length - "task-based development ".length)}`;
	const context = buildNamingRequestContext([], prompt);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(false);

	const token = `sk-${"A".repeat(24)}`;
	expect(hasSensitiveNamingContext(`task-based development using ${token}`)).toBe(true);
	expect(hasSensitiveNamingContext(`prefix${token}`)).toBe(true);

	const whitespaceObfuscatedToken = `sk-${"W".repeat(8)} ${"W".repeat(16)}`;
	expect(hasSensitiveNamingContext(whitespaceObfuscatedToken)).toBe(true);
	expect(hasSensitiveOutput(whitespaceObfuscatedToken)).toBe(true);
});

test("screens explicit credential assignments across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const tokenStart = prefixLength - 10;
	const label = " access_key: ";
	const credential = "M3n4".repeat(8);
	const prompt = `${"x".repeat(tokenStart - label.length)}${label}${credential} ${"x".repeat(1_200)}`;
	const context = buildNamingRequestContext([], prompt);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);
	expect(context.text).toBe(buildNamingContext([], prompt));

	const controlObfuscated = `${credential.slice(0, 8)}\u0000${credential.slice(8)}`;
	const obfuscatedPrompt = `${"x".repeat(tokenStart - label.length)}${label}${controlObfuscated} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

	const nineteenCharacters = "A".repeat(19);
	const shortPrompt = `${"x".repeat(tokenStart - label.length)}${label}${nineteenCharacters} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], shortPrompt).hasSensitiveBoundary()).toBe(false);
	const twentyCharacterCredential = "M3n4".repeat(5);
	const minimumLengthPrompt = `${"x".repeat(tokenStart - label.length)}${label}${twentyCharacterCredential} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], minimumLengthPrompt).hasSensitiveBoundary()).toBe(true);
	const unlabeledPrompt = `${"x".repeat(tokenStart)}${credential} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], unlabeledPrompt).hasSensitiveBoundary()).toBe(false);

	const historyContent = `${"x".repeat(985)}${label}${credential} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summaryContent = `${"x".repeat(970)}${label}${credential} y`;
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: summaryContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);
	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const suffixTokenStart = suffixStart - 10;
	const suffixPrompt = `${"x".repeat(suffixTokenStart - label.length)}${label}${credential} ${"y".repeat(promptLength - suffixTokenStart - credential.length - 1)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)}${label}${credential} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
});

test("screens framework, WordPress, and cryptographic key assignments across both prompt truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const credential = "K3y4".repeat(8);
	const assignments = [
		"APP_KEY", "AES_KEY", "AES_256_KEY", "AES-256-KEY", "SECRET_KEY_BASE", "ENCRYPTION_KEY", "FERNET_KEY", "HMAC_KEY", "MASTER_KEY",
		"AUTH_KEY", "SECURE_AUTH_KEY", "LOGGED_IN_KEY", "NONCE_KEY",
		"AUTH_SALT", "SECURE_AUTH_SALT", "LOGGED_IN_SALT", "NONCE_SALT",
	]
		.map((name) => ({ name, valuePrefix: "", value: credential }));
	assignments.push({ name: "APP_KEY", valuePrefix: "base64:", value: Buffer.from(credential).toString("base64") });
	assignments.push({ name: "FERNET_KEY", valuePrefix: "", value: Buffer.from(credential).toString("base64url") });
	assignments.push({ name: "HMAC_KEY", valuePrefix: "", value: Buffer.from(credential).toString("base64url") });
	assignments.push({ name: "AES_256_KEY", valuePrefix: "", value: Buffer.from(credential).toString("base64url") });

	for (const { name, valuePrefix, value } of assignments) {
		const assignment = `${name}=${valuePrefix}${value}`;
		expect(hasSensitiveNamingContext(assignment)).toBe(true);
		expect(hasSensitiveOutput(assignment)).toBe(true);

		const label = ` ${name}=`;
		const prefixTokenStart = prefixLength - 10;
		const prefixValueStart = prefixTokenStart - valuePrefix.length;
		const prefixPrompt = `${"x".repeat(prefixValueStart - label.length)}${label}${valuePrefix}${value} ${"y".repeat(1_200)}`;
		const prefixContext = buildNamingRequestContext([], prefixPrompt);
		expect(hasSensitiveNamingContext(prefixContext.text)).toBe(false);
		expect(prefixContext.hasSensitiveBoundary()).toBe(true);

		const promptLength = MAX_PROMPT_LENGTH + 300;
		const suffixStart = promptLength - Math.floor(retainedLength / 2);
		const suffixTokenStart = suffixStart - 10;
		const suffixValueStart = suffixTokenStart - valuePrefix.length;
		const suffixPrompt = `${"x".repeat(suffixValueStart - label.length)}${label}${valuePrefix}${value} ${"y".repeat(promptLength - suffixValueStart - valuePrefix.length - value.length - 1)}`;
		const suffixContext = buildNamingRequestContext([], suffixPrompt);
		expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
		expect(suffixContext.hasSensitiveBoundary()).toBe(true);
	}

	for (const nearMiss of [
		"APP_KEY=placeholder",
		"APP_KEY=base64:placeholder",
		"SECRET_KEY_BASE=redacted",
		"AUTH_KEY=put your unique phrase here",
		"LOGGED_IN_SALT=example",
		"FERNET_KEY=example",
		"HMAC_KEY=placeholder",
		"HMAC_KEY rotation in a synthetic project",
		`HMAC_KEY=${"H".repeat(19)}`,
		"AES_256_KEY=redacted",
		"AES-256 key rotation in a synthetic project",
		`AES_256_KEY=${"A".repeat(19)}`,
		`ENCRYPTION_KEY=${"A".repeat(19)}`,
		`MASTER_KEY=${"B".repeat(19)}`,
		`NONCE_SALT=${"N".repeat(19)}`,
		"APP_KEY rotation in a synthetic project",
		"rotate the secret key base after deployment",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens age secret identities across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const prefix = ["AGE", "SECRET", "KEY", "1"].join("-");
	const identity = `${prefix}${"Q".repeat(58)}`;
	expect(hasSensitiveNamingContext(identity)).toBe(true);
	expect(hasSensitiveOutput(identity)).toBe(true);

	const prompt = `${"x".repeat(prefixLength - 9)} ${identity} ${"x".repeat(1_200)}`;
	const context = buildNamingRequestContext([], prompt);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);

	const obfuscated = identity.replace("SECRET", "SEC\u200bRET");
	const obfuscatedPrompt = `${"x".repeat(prefixLength - 9)} ${obfuscated} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixLength = Math.floor(retainedLength / 2);
	const suffixStart = promptLength - suffixLength;
	const suffixTokenStart = suffixStart - 8;
	const suffixPrompt = `${"x".repeat(suffixTokenStart - 1)} ${identity} ${"y".repeat(promptLength - suffixTokenStart - identity.length - 1)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(991)} ${identity} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([{ role: "compactionSummary", summary: historyContent }] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)}${identity} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	const shortIdentity = `${prefix}${"Q".repeat(57)}`;
	const nearMiss = `${"x".repeat(prefixLength - 9)} ${shortIdentity} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], nearMiss).hasSensitiveBoundary()).toBe(false);
});

test("screens Docker Hub tokens across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const pat = `dckr_pat_${"A1b2_-".repeat(5).slice(0, 27)}`;
	const oat = `dckr_oat_${"C3d4_-".repeat(6).slice(0, 32)}`;
	const tokens = [pat, oat];
	for (const token of tokens) {
		expect(hasSensitiveNamingContext(token)).toBe(true);
		expect(hasSensitiveOutput(token)).toBe(true);

		const prompt = `${"x".repeat(prefixLength - 9)} ${token} ${"x".repeat(1_200)}`;
		const context = buildNamingRequestContext([], prompt);
		expect(hasSensitiveNamingContext(context.text)).toBe(false);
		expect(context.hasSensitiveBoundary()).toBe(true);

		const obfuscated = token.replace("dckr_", "dck\u200br_");
		const obfuscatedPrompt = `${"x".repeat(prefixLength - 9)} ${obfuscated} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);
		const controlObfuscated = `${token.slice(0, 20)}\u0000${token.slice(20)}`;
		const controlPrompt = `${"x".repeat(prefixLength - 9)} ${controlObfuscated} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], controlPrompt).hasSensitiveBoundary()).toBe(true);
	}

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixLength = Math.floor(retainedLength / 2);
	const suffixStart = promptLength - suffixLength;
	const suffixTokenStart = suffixStart - 8;
	const suffixPrompt = `${"x".repeat(suffixTokenStart - 1)} ${pat} ${"y".repeat(promptLength - suffixTokenStart - pat.length - 1)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(991)} ${pat} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summaryContent = `${"x".repeat(991)} ${oat} y`;
	const summary = buildNamingRequestContext([{ role: "compactionSummary", summary: summaryContent }] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)} ${pat} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	const nearMisses = [
		pat.slice(0, -1), `${pat}Z`, pat.replace("dckr_pat", "dckr_pot"),
		oat.slice(0, -1), `${oat}Z`, oat.replace("dckr_oat", "dckr_pat"),
	];
	for (const nearMiss of nearMisses) {
		const prompt = `${"x".repeat(prefixLength - 9)} ${nearMiss} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], prompt).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens Azure DevOps and GitLab Runner tokens across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const azureToken = `${"a".repeat(75)}AZDO${"B".repeat(5)}`;
	const runnerToken = `glrt-${"A1b2_-".repeat(3)}Z9`;
	const cases = [
		{
			token: azureToken,
			obfuscated: azureToken.replace("AZDO", "AZ\u200bDO"),
			controlObfuscated: `${azureToken.slice(0, 42)}\u0000${azureToken.slice(42)}`,
			nearMisses: [
				azureToken.slice(0, -1), azureToken.replace("AZDO", "AZDX"), `${azureToken}Z`, `x${azureToken}`, `_${azureToken}`,
			],
		},
		{
			token: runnerToken,
			obfuscated: runnerToken.replace("glrt", "gl\u200brt"),
			controlObfuscated: `${runnerToken.slice(0, 12)}\u0000${runnerToken.slice(12)}`,
			nearMisses: [
				runnerToken.slice(0, -1), `${runnerToken}Z`, runnerToken.replace("glrt", "glrx"), `x${runnerToken}`, `_${runnerToken}`,
			],
		},
	];

	for (const { token, obfuscated, controlObfuscated, nearMisses } of cases) {
		expect(hasSensitiveNamingContext(token)).toBe(true);
		expect(hasSensitiveOutput(token)).toBe(true);

		const promptAtPrefixBoundary = (value: string) => {
			const tokenStart = prefixLength - Math.floor(value.length / 2);
			return `${"x".repeat(tokenStart - 1)} ${value} ${"x".repeat(1_200)}`;
		};
		const prefixPrompt = promptAtPrefixBoundary(token);
		const prefixContext = buildNamingRequestContext([], prefixPrompt);
		expect(hasSensitiveNamingContext(prefixContext.text)).toBe(false);
		expect(prefixContext.hasSensitiveBoundary()).toBe(true);
		expect(buildNamingRequestContext([], promptAtPrefixBoundary(obfuscated)).hasSensitiveBoundary()).toBe(true);
		expect(buildNamingRequestContext([], promptAtPrefixBoundary(controlObfuscated)).hasSensitiveBoundary()).toBe(true);

		const promptLength = MAX_PROMPT_LENGTH + 300;
		const suffixStart = promptLength - Math.floor(retainedLength / 2);
		const suffixTokenStart = suffixStart - Math.floor(token.length / 2);
		const leading = `${"x".repeat(suffixTokenStart - 1)} `;
		const tokenAndSpace = `${token} `;
		const suffixPrompt = leading + tokenAndSpace
			+ "y".repeat(promptLength - leading.length - tokenAndSpace.length);
		const suffixContext = buildNamingRequestContext([], suffixPrompt);
		expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
		expect(suffixContext.hasSensitiveBoundary()).toBe(true);

		const historyContent = `${"x".repeat(999 - Math.floor(token.length / 2))} ${token} y`;
		const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
		expect(hasSensitiveNamingContext(history.text)).toBe(false);
		expect(history.hasSensitiveBoundary()).toBe(true);
		const summary = buildNamingRequestContext([
			{ role: "compactionSummary", summary: historyContent },
		] as any);
		expect(hasSensitiveNamingContext(summary.text)).toBe(false);
		expect(summary.hasSensitiveBoundary()).toBe(true);

		const omittedPrompt = `${"x".repeat(prefixLength + 20)} ${token} ${"y".repeat(3_000)}`;
		expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
		for (const nearMiss of nearMisses) {
			expect(buildNamingRequestContext([], promptAtPrefixBoundary(nearMiss)).hasSensitiveBoundary()).toBe(false);
		}
	}
});

test("screens Azure AD, Alibaba, and Tencent credentials across retained-context boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const azureSecret = (bodyLength: number) => `AbC7Q~${"Aa0_-.".repeat(6).slice(0, bodyLength)}`;
	const alibabaKey = `LTAI${"A1b2".repeat(5)}`;
	const tencentSecretId = `AKID${"C3d4".repeat(8)}`;
	const cases = [
		{
			token: azureSecret(31),
			obfuscated: azureSecret(31).replace("Q~", "Q\u200b~"),
			controlObfuscated: `${azureSecret(31).slice(0, 18)}\u0000${azureSecret(31).slice(18)}`,
			nearMisses: [azureSecret(30), azureSecret(35), azureSecret(31).replace("Q~", "R~"), `_${azureSecret(31)}`],
		},
		{
			token: azureSecret(34),
			obfuscated: azureSecret(34).replace("AbC7", "Ab\u200bC7"),
			controlObfuscated: `${azureSecret(34).slice(0, 18)}\u0000${azureSecret(34).slice(18)}`,
			nearMisses: [azureSecret(35), azureSecret(34).replace("Q~", "Q!"), `_${azureSecret(34)}`],
		},
		{
			token: alibabaKey,
			obfuscated: alibabaKey.replace("LTAI", "LT\u200bAI"),
			controlObfuscated: `${alibabaKey.slice(0, 12)}\u0000${alibabaKey.slice(12)}`,
			nearMisses: [alibabaKey.slice(0, -1), `${alibabaKey}A`, alibabaKey.replace("LTAI", "LTAJ"), `_${alibabaKey}`],
		},
		{
			token: tencentSecretId,
			obfuscated: tencentSecretId.replace("AKID", "A\u200bKID"),
			controlObfuscated: `${tencentSecretId.slice(0, 18)}\u0000${tencentSecretId.slice(18)}`,
			nearMisses: [tencentSecretId.slice(0, -1), `${tencentSecretId}A`, tencentSecretId.replace("AKID", "AKIE"), `_${tencentSecretId}`],
		},
	];

	for (const { token, obfuscated, controlObfuscated, nearMisses } of cases) {
		expect(hasSensitiveNamingContext(token)).toBe(true);
		expect(hasSensitiveOutput(token)).toBe(true);

		const promptAtPrefixBoundary = (value: string) => {
			const tokenStart = prefixLength - Math.floor(value.length / 2);
			return `${"x".repeat(tokenStart - 1)} ${value} ${"x".repeat(1_200)}`;
		};
		const prefixPrompt = promptAtPrefixBoundary(token);
		const prefixContext = buildNamingRequestContext([], prefixPrompt);
		expect(hasSensitiveNamingContext(prefixContext.text)).toBe(false);
		expect(prefixContext.hasSensitiveBoundary()).toBe(true);
		expect(buildNamingRequestContext([], promptAtPrefixBoundary(obfuscated)).hasSensitiveBoundary()).toBe(true);
		expect(buildNamingRequestContext([], promptAtPrefixBoundary(controlObfuscated)).hasSensitiveBoundary()).toBe(true);

		const promptLength = MAX_PROMPT_LENGTH + 300;
		const suffixStart = promptLength - Math.floor(retainedLength / 2);
		const suffixTokenStart = suffixStart - Math.floor(token.length / 2);
		const leading = `${"x".repeat(suffixTokenStart - 1)} `;
		const tokenAndSpace = `${token} `;
		const suffixPrompt = leading + tokenAndSpace
			+ "y".repeat(promptLength - leading.length - tokenAndSpace.length);
		const suffixContext = buildNamingRequestContext([], suffixPrompt);
		expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
		expect(suffixContext.hasSensitiveBoundary()).toBe(true);

		const historyContent = `${"x".repeat(999 - Math.floor(token.length / 2))} ${token} y`;
		const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
		expect(hasSensitiveNamingContext(history.text)).toBe(false);
		expect(history.hasSensitiveBoundary()).toBe(true);
		const summary = buildNamingRequestContext([
			{ role: "compactionSummary", summary: historyContent },
		] as any);
		expect(hasSensitiveNamingContext(summary.text)).toBe(false);
		expect(summary.hasSensitiveBoundary()).toBe(true);

		const omittedPrompt = `${"x".repeat(prefixLength + 20)} ${token} ${"y".repeat(3_000)}`;
		expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
		for (const nearMiss of nearMisses) {
			expect(buildNamingRequestContext([], promptAtPrefixBoundary(nearMiss)).hasSensitiveBoundary()).toBe(false);
		}
	}
});

test("screens Airtable and ClickHouse keys across retained-context boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const airtableToken = `pat${"A1b2".repeat(3)}A1.${"a1b2".repeat(16)}`;
	const clickhouseKey = `4b1d${"A1b2".repeat(9)}A1`;
	const cases = [
		{
			token: airtableToken,
			obfuscated: airtableToken.replace("pat", "p\u200bat"),
			controlObfuscated: `${airtableToken.slice(0, 30)}\u0000${airtableToken.slice(30)}`,
			nearMisses: [
				airtableToken.slice(0, -1), `${airtableToken}A`, airtableToken.replace("pat", "pbt"), airtableToken.replace(".", "_"),
			],
		},
		{
			token: clickhouseKey,
			obfuscated: clickhouseKey.replace("4b1d", "4b\u200b1d"),
			controlObfuscated: `${clickhouseKey.slice(0, 20)}\u0000${clickhouseKey.slice(20)}`,
			nearMisses: [
				clickhouseKey.slice(0, -1), `${clickhouseKey}A`, clickhouseKey.replace("4b1d", "4b1e"), `_${clickhouseKey}`,
			],
		},
	];

	for (const { token, obfuscated, controlObfuscated, nearMisses } of cases) {
		expect(hasSensitiveNamingContext(token)).toBe(true);
		expect(hasSensitiveOutput(token)).toBe(true);

		const promptAtPrefixBoundary = (value: string) => {
			const tokenStart = prefixLength - Math.floor(value.length / 2);
			return `${"x".repeat(tokenStart - 1)} ${value} ${"x".repeat(1_200)}`;
		};
		const prefixPrompt = promptAtPrefixBoundary(token);
		const prefixContext = buildNamingRequestContext([], prefixPrompt);
		expect(hasSensitiveNamingContext(prefixContext.text)).toBe(false);
		expect(prefixContext.hasSensitiveBoundary()).toBe(true);
		expect(buildNamingRequestContext([], promptAtPrefixBoundary(obfuscated)).hasSensitiveBoundary()).toBe(true);
		expect(buildNamingRequestContext([], promptAtPrefixBoundary(controlObfuscated)).hasSensitiveBoundary()).toBe(true);

		const promptLength = MAX_PROMPT_LENGTH + 300;
		const suffixStart = promptLength - Math.floor(retainedLength / 2);
		const suffixTokenStart = suffixStart - Math.floor(token.length / 2);
		const leading = `${"x".repeat(suffixTokenStart - 1)} `;
		const tokenAndSpace = `${token} `;
		const suffixPrompt = leading + tokenAndSpace
			+ "y".repeat(promptLength - leading.length - tokenAndSpace.length);
		const suffixContext = buildNamingRequestContext([], suffixPrompt);
		expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
		expect(suffixContext.hasSensitiveBoundary()).toBe(true);

		const historyContent = `${"x".repeat(999 - Math.floor(token.length / 2))} ${token} y`;
		const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
		expect(hasSensitiveNamingContext(history.text)).toBe(false);
		expect(history.hasSensitiveBoundary()).toBe(true);
		const summary = buildNamingRequestContext([
			{ role: "compactionSummary", summary: historyContent },
		] as any);
		expect(hasSensitiveNamingContext(summary.text)).toBe(false);
		expect(summary.hasSensitiveBoundary()).toBe(true);

		const omittedPrompt = `${"x".repeat(prefixLength + 20)} ${token} ${"y".repeat(3_000)}`;
		expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
		for (const nearMiss of nearMisses) {
			expect(buildNamingRequestContext([], promptAtPrefixBoundary(nearMiss)).hasSensitiveBoundary()).toBe(false);
		}
	}
});

test("screens Replicate API tokens across retained-context boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const token = `r8_${"A1b2".repeat(9)}A`;
	const obfuscated = token.replace("r8_", "r\u200b8_");
	const controlObfuscated = `${token.slice(0, 20)}\u0000${token.slice(20)}`;
	const tokenStart = prefixLength - Math.floor(token.length / 2);
	const prompt = (value: string) => `${"x".repeat(tokenStart - 1)} ${value} ${"x".repeat(1_200)}`;
	const context = buildNamingRequestContext([], prompt(token));
	expect(hasSensitiveNamingContext(token)).toBe(true);
	expect(hasSensitiveOutput(token)).toBe(true);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);
	expect(buildNamingRequestContext([], prompt(obfuscated)).hasSensitiveBoundary()).toBe(true);
	expect(buildNamingRequestContext([], prompt(controlObfuscated)).hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const suffixTokenStart = suffixStart - Math.floor(token.length / 2);
	const leading = `${"x".repeat(suffixTokenStart - 1)} `;
	const tokenAndSpace = `${token} `;
	const suffixPrompt = leading + tokenAndSpace
		+ "y".repeat(promptLength - leading.length - tokenAndSpace.length);
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(999 - Math.floor(token.length / 2))} ${token} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: historyContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)} ${token} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	for (const nearMiss of [
		token.slice(0, -1), `${token}A`, token.replace("r8_", "r9_"),
	]) {
		expect(buildNamingRequestContext([], prompt(nearMiss)).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens Pinecone API keys across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const token = `pcsk_test1_${"A".repeat(63)}`;
	const obfuscated = token.replace("pcsk_", "pc\u200bsk_");
	const controlObfuscated = `${token.slice(0, 20)}\u0000${token.slice(20)}`;
	const tokenStart = prefixLength - Math.floor(token.length / 2);
	const prompt = (value: string) => `${"x".repeat(tokenStart - 1)} ${value} ${"x".repeat(1_200)}`;
	const context = buildNamingRequestContext([], prompt(token));
	expect(hasSensitiveNamingContext(token)).toBe(true);
	expect(hasSensitiveOutput(token)).toBe(true);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);
	expect(buildNamingRequestContext([], prompt(obfuscated)).hasSensitiveBoundary()).toBe(true);
	expect(buildNamingRequestContext([], prompt(controlObfuscated)).hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const suffixTokenStart = suffixStart - Math.floor(token.length / 2);
	const leading = `${"x".repeat(suffixTokenStart - 1)} `;
	const tokenAndSpace = `${token} `;
	const suffixPrompt = leading + tokenAndSpace
		+ "y".repeat(promptLength - leading.length - tokenAndSpace.length);
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(999 - Math.floor(token.length / 2))} ${token} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: historyContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)} ${token} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	for (const nearMiss of [
		token.slice(0, -1), `${token}A`, token.replace("test1", "test"), token.replace("pcsk_", "pcst_"),
	]) {
		expect(buildNamingRequestContext([], prompt(nearMiss)).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens Linear API tokens across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const token = `lin_api_${"A1b2".repeat(10)}`;
	const obfuscated = token.replace("lin_api_", "lin\u200b_api_");
	const controlObfuscated = `${token.slice(0, 20)}\u0000${token.slice(20)}`;
	const tokenStart = prefixLength - Math.floor(token.length / 2);
	const prompt = (value: string) => `${"x".repeat(tokenStart - 1)} ${value} ${"x".repeat(1_200)}`;
	const context = buildNamingRequestContext([], prompt(token));
	expect(hasSensitiveNamingContext(token)).toBe(true);
	expect(hasSensitiveOutput(token)).toBe(true);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);
	expect(buildNamingRequestContext([], prompt(obfuscated)).hasSensitiveBoundary()).toBe(true);
	expect(buildNamingRequestContext([], prompt(controlObfuscated)).hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const suffixTokenStart = suffixStart - Math.floor(token.length / 2);
	const leading = `${"x".repeat(suffixTokenStart - 1)} `;
	const tokenAndSpace = `${token} `;
	const suffixPrompt = leading + tokenAndSpace
		+ "y".repeat(promptLength - leading.length - tokenAndSpace.length);
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(999 - Math.floor(token.length / 2))} ${token} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: historyContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)} ${token} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	for (const nearMiss of [
		token.slice(0, -1), `${token}A`, token.replace("lin_api_", "lin_apy_"),
	]) {
		expect(buildNamingRequestContext([], prompt(nearMiss)).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens Neon API keys without flagging near-misses", () => {
	const token = `neon_api_key_${"A1_b-".repeat(6)}AB`;
	const obfuscatedTokens = [
		token.replace("neon_", "ne\u200bon_"),
		token.replace("A1_b-", "A1_\u200bb-"),
		`${token.slice(0, 20)}\u0000${token.slice(20)}`,
	];

	for (const value of [token, ...obfuscatedTokens]) {
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}

	for (const nearMiss of [
		`neon_api_key_${"A1_b-".repeat(6)}A`,
		`neon_api_key_${"A1_b-".repeat(6)}ABC`,
		token.replace("neon_api_key_", "neon_api_keys_"),
		token.replace("A1_b-", "A1_b!"),
		`prefix${token}`,
		`${token}suffix`,
		"Neon database connection setup",
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("strips non-whitespace controls from credentials without joining surrounding prose", () => {
	const token = `neon_api_key_${"A1_b-".repeat(6)}AB`;
	const values = [
		`${token.slice(0, 20)}\u0000${token.slice(20)}`,
		`${token.slice(0, 20)}\u0080${token.slice(20)}`,
	];

	for (const value of values) {
		const text = `Review Neon access ${value}`;
		expect(hasSensitiveNamingContext(text)).toBe(true);
		expect(hasSensitiveOutput(text)).toBe(true);
	}
});

test("screens whitespace-obfuscated credentials embedded in ordinary prose", () => {
	const token = `neon_api_key_${"A1_b-".repeat(6)}AB`;
	const obfuscated = `${token.slice(0, 20)} ${token.slice(20)}`;
	const text = `Review Neon access ${obfuscated} before deployment`;

	expect(hasSensitiveNamingContext(text)).toBe(true);
	expect(hasSensitiveOutput(text)).toBe(true);
	for (const nearMiss of [
		`Review Neon access ${obfuscated.slice(0, -1)} before deployment`,
		`Review Neon access ${obfuscated.replace("neon_api_key_", "neon_api_keys_")} before deployment`,
		`prefix${obfuscated}`,
		`${obfuscated}suffix`,
	]) {
		expect(hasSensitiveNamingContext(nearMiss)).toBe(false);
		expect(hasSensitiveOutput(nearMiss)).toBe(false);
	}
});

test("screens Neon API keys across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const token = `neon_api_key_${"A1_b-".repeat(6)}AB`;
	const obfuscated = token.replace("neon_api_key_", "neon_\u200bapi_key_");
	const controlObfuscated = `${token.slice(0, 20)}\u0000${token.slice(20)}`;
	const promptAtPrefixBoundary = (value: string) => {
		const tokenStart = prefixLength - Math.floor(value.length / 2);
		return `${"x".repeat(tokenStart - 1)} ${value} ${"x".repeat(1_200)}`;
	};
	const prompt = promptAtPrefixBoundary(token);
	const context = buildNamingRequestContext([], prompt);
	expect(hasSensitiveNamingContext(token)).toBe(true);
	expect(hasSensitiveOutput(token)).toBe(true);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);
	expect(context.text).toBe(buildNamingContext([], prompt));
	expect(buildNamingRequestContext([], promptAtPrefixBoundary(obfuscated)).hasSensitiveBoundary()).toBe(true);
	expect(buildNamingRequestContext([], promptAtPrefixBoundary(controlObfuscated)).hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const suffixTokenStart = suffixStart - Math.floor(token.length / 2);
	const leading = `${"x".repeat(suffixTokenStart - 1)} `;
	const tokenAndSpace = `${token} `;
	const suffixPrompt = leading + tokenAndSpace
		+ "y".repeat(promptLength - leading.length - tokenAndSpace.length);
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(999 - Math.floor(token.length / 2))} ${token} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: historyContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)} ${token} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	for (const nearMiss of [
		token.slice(0, -1), `${token}A`, token.replace("neon_api_key_", "neon_api_keys_"),
	]) {
		expect(buildNamingRequestContext([], promptAtPrefixBoundary(nearMiss)).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens Slack API tokens across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const token = `xoxb-${"A1b2".repeat(8)}`;
	const appToken = `xapp-${"C3d4".repeat(8)}`;
	expect(hasSensitiveNamingContext(token)).toBe(true);
	expect(hasSensitiveOutput(token)).toBe(true);
	expect(hasSensitiveNamingContext(appToken)).toBe(true);

	const prompt = `${"x".repeat(prefixLength - 8)}${token} ${"x".repeat(1_200)}`;
	const context = buildNamingRequestContext([], prompt);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);

	const obfuscatedToken = token.replace("xoxb", "xox\u200bb");
	const obfuscatedPrompt = `${"x".repeat(prefixLength - 8)}${obfuscatedToken} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);
	const controlObfuscatedToken = `${token.slice(0, 20)}\u0000${token.slice(20)}`;
	const controlObfuscatedPrompt = `${"x".repeat(prefixLength - 8)}${controlObfuscatedToken} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], controlObfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixLength = Math.floor(retainedLength / 2);
	const suffixStart = promptLength - suffixLength;
	const suffixTokenStart = suffixStart - 8;
	const suffixPrompt = `${"x".repeat(suffixTokenStart)}${token}${"y".repeat(promptLength - suffixTokenStart - token.length)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(992)}${token} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summaryContent = `${"x".repeat(992)}${appToken} y`;
	const summary = buildNamingRequestContext([{ role: "compactionSummary", summary: summaryContent }] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)}${token} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	const shortToken = `xoxb-${"A".repeat(9)}`;
	const nearMiss = `${"x".repeat(prefixLength - 8)}${shortToken} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], nearMiss).hasSensitiveBoundary()).toBe(false);
	const wrongPrefix = `${"x".repeat(prefixLength - 8)}xozb-${"A".repeat(24)} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], wrongPrefix).hasSensitiveBoundary()).toBe(false);
});

test("screens private-key headers across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const headers = [
		["-----BEGIN ", "PRIVATE KEY-----"].join(""),
		["-----BEGIN RSA ", "PRIVATE KEY-----"].join(""),
		["-----BEGIN DSA ", "PRIVATE KEY-----"].join(""),
		["-----BEGIN EC ", "PRIVATE KEY-----"].join(""),
		["-----BEGIN OPENSSH ", "PRIVATE KEY-----"].join(""),
		["-----BEGIN ENCRYPTED ", "PRIVATE KEY-----"].join(""),
		["-----BEGIN PGP ", "PRIVATE KEY BLOCK-----"].join(""),
		"---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----",
		"PuTTY-User-Key-File-2:",
		"PuTTY-User-Key-File-3:",
	];

	for (const header of headers) {
		const prompt = `${"x".repeat(prefixLength - 8)}${header} ${"x".repeat(1_200)}`;
		const context = buildNamingRequestContext([], prompt);
		expect(hasSensitiveNamingContext(context.text)).toBe(false);
		expect(context.hasSensitiveBoundary()).toBe(true);
	}

	const header = ["-----BEGIN OPENSSH ", "PRIVATE KEY-----"].join("");
	const controlObfuscatedHeader = header.replace("OPENSSH", "OPE\u200bNSSH");
	const obfuscatedPrompt = `${"x".repeat(prefixLength - 8)}${controlObfuscatedHeader} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixLength = Math.floor(retainedLength / 2);
	const suffixStart = promptLength - suffixLength;
	const suffixPrompt = `${"x".repeat(suffixStart - 8)}${header}${"y".repeat(promptLength - suffixStart - header.length + 8)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(992)}${header} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([{ role: "compactionSummary", summary: historyContent }] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)}${header} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	const nearMiss = `${"x".repeat(prefixLength - 8)}${["-----BEGIN ", "PUBLIC KEY-----"].join("")} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], nearMiss).hasSensitiveBoundary()).toBe(false);
});

test("screens bearer credentials across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const label = "Bearer ";
	const token = "A1b2".repeat(8);
	const tokenStart = prefixLength - 8;
	const prompt = `${"x".repeat(tokenStart - label.length)}${label}${token} ${"x".repeat(1_200)}`;
	const prefixContext = buildNamingRequestContext([], prompt);
	expect(hasSensitiveNamingContext(prefixContext.text)).toBe(false);
	expect(prefixContext.hasSensitiveBoundary()).toBe(true);

	const controlObfuscatedToken = `${token.slice(0, 18)}\u0000${token.slice(18)}`;
	const obfuscatedPrompt = `${"x".repeat(tokenStart - label.length)}${label}${controlObfuscatedToken} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(1_000 - label.length - 8)}${label}${token} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: historyContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixLength = Math.floor(retainedLength / 2);
	const suffixStart = promptLength - suffixLength;
	const suffixTokenStart = suffixStart - token.length + 8;
	const suffixPrompt = `${"x".repeat(suffixTokenStart - label.length)}${label}${token} ${"y".repeat(promptLength - suffixTokenStart - token.length - 1)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const longToken = "A1b2".repeat(20);
	const spacedToken = `${longToken.slice(0, 10)} ${longToken.slice(10)}`;
	const spacedTokenStart = suffixStart - 5;
	const spacedPrompt = `${"x".repeat(spacedTokenStart - label.length)}${label}${spacedToken}`
		+ "y".repeat(promptLength - spacedTokenStart - spacedToken.length);
	const spacedContext = buildNamingRequestContext([], spacedPrompt);
	expect(hasSensitiveNamingContext(spacedContext.text)).toBe(false);
	expect(spacedContext.hasSensitiveBoundary()).toBe(true);

	const splitLabel = "Bea rer";
	const splitLabelStart = suffixStart - 3;
	const splitLabelPrompt = `${"x".repeat(splitLabelStart)}${splitLabel} ${token}`
		+ "y".repeat(promptLength - splitLabelStart - splitLabel.length - 1 - token.length);
	const splitLabelContext = buildNamingRequestContext([], splitLabelPrompt);
	expect(hasSensitiveNamingContext(splitLabelContext.text)).toBe(false);
	expect(splitLabelContext.hasSensitiveBoundary()).toBe(true);

	const splitLabelProse = "B e a r e r authentication v2";
	const splitLabelProseStart = suffixStart - 10;
	const splitLabelProsePrompt = `${"x".repeat(splitLabelProseStart)}${splitLabelProse} `
		+ "y".repeat(promptLength - splitLabelProseStart - `${splitLabelProse} `.length);
	const splitLabelProseContext = buildNamingRequestContext([], splitLabelProsePrompt);
	expect(hasSensitiveNamingContext(splitLabelProseContext.text)).toBe(false);
	expect(splitLabelProseContext.hasSensitiveBoundary()).toBe(false);

	for (const prose of ["Bearer authentication v2", "Bearer authentication\nv2"]) {
		const proseSuffixStart = suffixStart - 10;
		const proseSuffixPrompt = `${"x".repeat(proseSuffixStart)}${prose} `
			+ "y".repeat(promptLength - proseSuffixStart - `${prose} `.length);
		const proseSuffixContext = buildNamingRequestContext([], proseSuffixPrompt);
		expect(hasSensitiveNamingContext(proseSuffixContext.text)).toBe(false);
		expect(proseSuffixContext.hasSensitiveBoundary()).toBe(false);
	}

	const omittedPrompt = `${"x".repeat(prefixLength + 20)}${label}${token} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	const omittedSpacedPrompt = `${"x".repeat(prefixLength + 20)}${label}${spacedToken} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedSpacedPrompt).hasSensitiveBoundary()).toBe(false);
	const shortPrompt = `${"x".repeat(tokenStart - label.length)}${label}${"A".repeat(15)} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], shortPrompt).hasSensitiveBoundary()).toBe(false);
	const omittedSpacedLabelPrompt = `${"x".repeat(prefixLength + 20)}B e a r e r ${token} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedSpacedLabelPrompt).hasSensitiveBoundary()).toBe(false);

	const prose = "Bearer authentication v2";
	const proseStart = prefixLength - 10;
	const prosePrompt = `${"x".repeat(proseStart)}${prose} ${"x".repeat(1_200)}`;
	const proseContext = buildNamingRequestContext([], prosePrompt);
	expect(hasSensitiveNamingContext(proseContext.text)).toBe(false);
	expect(proseContext.hasSensitiveBoundary()).toBe(false);
});

test("screens bearer values with whitespace-obfuscated labels without blocking prose", () => {
	const token = "A1b2".repeat(8);
	for (const label of ["Bea rer", "B e a r e r", "Be\u200ba rer"]) {
		const value = `${label} ${token}`;
		expect(hasSensitiveNamingContext(value)).toBe(true);
		expect(hasSensitiveOutput(value)).toBe(true);
	}
	const prose = "B e a r e r authentication v2";
	expect(hasSensitiveNamingContext(prose)).toBe(false);
	expect(hasSensitiveOutput(prose)).toBe(false);
});

test("screens short labeled passwords and passphrases across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const cases = [
		{ label: " password: ", value: "R4nd0mxZ;" },
		{ label: ' password: "', value: 'my strong phrase";' },
		{ label: " passphrase: ", value: "my strong phrase;" },
		{ label: " password: |-\n  ", value: "R4nd0mxZ\n" },
	];
	const promptAtPrefixBoundary = (label: string, value: string) => {
		const valueStart = prefixLength - 3;
		return `${"x".repeat(valueStart - label.length)}${label}${value} ${"y".repeat(1_200)}`;
	};

	for (const { label, value } of cases) {
		const prompt = promptAtPrefixBoundary(label, value);
		const context = buildNamingRequestContext([], prompt);
		expect(hasSensitiveNamingContext(context.text)).toBe(false);
		expect(context.hasSensitiveBoundary()).toBe(true);
		expect(context.text).toBe(buildNamingContext([], prompt));

		const promptLength = MAX_PROMPT_LENGTH + 300;
		const suffixStart = promptLength - Math.floor(retainedLength / 2);
		const suffixValueStart = suffixStart - 3;
		const suffixPrompt = `${"x".repeat(suffixValueStart - label.length)}${label}${value}`
			+ `${"y".repeat(promptLength - suffixValueStart - value.length)}`;
		const suffixContext = buildNamingRequestContext([], suffixPrompt);
		expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
		expect(suffixContext.hasSensitiveBoundary()).toBe(true);

		const historyContent = `${"x".repeat(993 - label.length)}${label}${value} y`;
		for (const input of [
			[{ role: "user", content: historyContent }],
			[{ role: "compactionSummary", summary: historyContent }],
		] as any[]) {
			const history = buildNamingRequestContext(input);
			expect(hasSensitiveNamingContext(history.text)).toBe(false);
			expect(history.hasSensitiveBoundary()).toBe(true);
		}
	}

	const controlObfuscated = promptAtPrefixBoundary(" password: ", "R4nd0m\u0000xZ;");
	expect(buildNamingRequestContext([], controlObfuscated).hasSensitiveBoundary()).toBe(true);
	for (const [label, value] of [
		[" password: ", "placeholder;"],
		[" password: ", "R4nd0mx;"],
		[" passphrase: ", "example phrase;"],
		[" password: |-\n  ", "placeholder\n"],
	] as const) {
		expect(buildNamingRequestContext([], promptAtPrefixBoundary(label, value)).hasSensitiveBoundary()).toBe(false);
	}
	const npmPasswordLabel = "//registry.npmjs.org/:_password=";
	const encodedPlaceholder = Buffer.from("example").toString("base64");
	const npmPlaceholderStart = prefixLength - 3;
	const npmPlaceholderPrompt = `${"x".repeat(npmPlaceholderStart - npmPasswordLabel.length)}`
		+ `${npmPasswordLabel}${encodedPlaceholder}; ${"y".repeat(1_200)}`;
	expect(buildNamingRequestContext([], npmPlaceholderPrompt).hasSensitiveBoundary()).toBe(false);
});

test("screens labeled SSNs and phone numbers across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const cases = [
		{ label: " SSN: ", value: "000-00-0000", shortValue: "000-00-000" },
		{ label: " Phone: ", value: "000-000-0000", shortValue: "000-000" },
	];

	for (const { label, value, shortValue } of cases) {
		const prefixValueStart = prefixLength - 6;
		const prompt = `${"x".repeat(prefixValueStart - label.length)}${label}${value} ${"x".repeat(1_200)}`;
		const prefixContext = buildNamingRequestContext([], prompt);
		expect(hasSensitiveNamingContext(prefixContext.text)).toBe(false);
		expect(prefixContext.hasSensitiveBoundary()).toBe(true);
		expect(prefixContext.text).toBe(buildNamingContext([], prompt));
		const controlObfuscatedValue = `${value.slice(0, 6)}\u0000${value.slice(6)}`;
		const obfuscatedPrompt = `${"x".repeat(prefixValueStart - label.length)}${label}${controlObfuscatedValue} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

		const historyContent = `${"x".repeat(993 - label.length)}${label}${value} y`;
		const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
		expect(hasSensitiveNamingContext(history.text)).toBe(false);
		expect(history.hasSensitiveBoundary()).toBe(true);
		const summary = buildNamingRequestContext([
			{ role: "compactionSummary", summary: historyContent },
		] as any);
		expect(hasSensitiveNamingContext(summary.text)).toBe(false);
		expect(summary.hasSensitiveBoundary()).toBe(true);

		const promptLength = MAX_PROMPT_LENGTH + 300;
		const suffixStart = promptLength - Math.floor(retainedLength / 2);
		const suffixValueStart = suffixStart - 6;
		const suffixPrompt = `${"x".repeat(suffixValueStart - label.length)}${label}${value} ${"y".repeat(promptLength - suffixValueStart - value.length - 1)}`;
		const suffixContext = buildNamingRequestContext([], suffixPrompt);
		expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
		expect(suffixContext.hasSensitiveBoundary()).toBe(true);

		const omittedPrompt = `${"x".repeat(prefixLength + 20)}${label}${value} ${"y".repeat(3_000)}`;
		expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
		const labelOnlyPrompt = `${"x".repeat(prefixLength - label.length)}${label}${value} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], labelOnlyPrompt).hasSensitiveBoundary()).toBe(false);
		const unlabeledPrompt = `${"x".repeat(prefixValueStart - 1)} ${value} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], unlabeledPrompt).hasSensitiveBoundary()).toBe(false);
		const nearMissPrompt = `${"x".repeat(prefixValueStart - label.length)}${label}${shortValue} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], nearMissPrompt).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens Luhn-valid labeled payment cards across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const label = " Card Number: ";
	const value = "0000-0000-0000-0000";
	const invalidLuhnValue = "0000-0000-0000-0001";
	const prefixValueStart = prefixLength - 8;
	const prompt = `${"x".repeat(prefixValueStart - label.length)}${label}${value} ${"x".repeat(1_200)}`;
	const prefixContext = buildNamingRequestContext([], prompt);
	expect(hasSensitiveNamingContext(prefixContext.text)).toBe(false);
	expect(prefixContext.hasSensitiveBoundary()).toBe(true);
	expect(prefixContext.text).toBe(buildNamingContext([], prompt));

	const obfuscatedValue = `${value.slice(0, 8)}\u0000${value.slice(8)}`;
	const obfuscatedPrompt = `${"x".repeat(prefixValueStart - label.length)}${label}${obfuscatedValue} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(988 - label.length)}${label}${value} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: historyContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const suffixValueStart = suffixStart - 8;
	const suffixPrompt = `${"x".repeat(suffixValueStart - label.length)}${label}${value} ${"y".repeat(promptLength - suffixValueStart - value.length - 1)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)}${label}${value} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	const labelOnlyPrompt = `${"x".repeat(prefixLength - label.length)}${label}${value} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], labelOnlyPrompt).hasSensitiveBoundary()).toBe(false);
	const unlabeledPrompt = `${"x".repeat(prefixValueStart - 1)} ${value} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], unlabeledPrompt).hasSensitiveBoundary()).toBe(false);
	const invalidLuhnPrompt = `${"x".repeat(prefixValueStart - label.length)}${label}${invalidLuhnValue} ${"x".repeat(1_200)}`;
	expect(hasSensitiveNamingContext(`${label}${invalidLuhnValue}`)).toBe(false);
	expect(buildNamingRequestContext([], invalidLuhnPrompt).hasSensitiveBoundary()).toBe(false);
});

test("screens email addresses across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const address = "alice@example.test";
	const prefixAddressStart = prefixLength - 6;
	const prompt = `${"x".repeat(prefixAddressStart - 1)} ${address} ${"x".repeat(1_200)}`;
	const prefixContext = buildNamingRequestContext([], prompt);
	expect(hasSensitiveNamingContext(prefixContext.text)).toBe(false);
	expect(prefixContext.hasSensitiveBoundary()).toBe(true);

	const obfuscatedAddress = address.replace("@", "@\u200b");
	const obfuscatedPrompt = `${"x".repeat(prefixAddressStart - 1)} ${obfuscatedAddress} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(993)} ${address} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: historyContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixLength = Math.floor(retainedLength / 2);
	const suffixStart = promptLength - suffixLength;
	const suffixAddressStart = suffixStart - address.length + 6;
	const suffixPrompt = `${"x".repeat(suffixAddressStart - 1)} ${address} ${"y".repeat(promptLength - suffixAddressStart - address.length - 1)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const omittedAddressPrompt = `${"x".repeat(prefixLength + 19)} ${address} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedAddressPrompt).hasSensitiveBoundary()).toBe(false);
	const nearMiss = "alice@example.x";
	const nearMissPrompt = `${"x".repeat(prefixAddressStart - 1)} ${nearMiss} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], nearMissPrompt).hasSensitiveBoundary()).toBe(false);
});

test("screens GitHub tokens across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const tokens = [`ghp_${"A".repeat(36)}`, `github_pat_${"B".repeat(30)}`];

	for (const token of tokens) {
		const prefixTokenStart = prefixLength - 8;
		const prompt = `${"x".repeat(prefixTokenStart)}${token} ${"x".repeat(1_200)}`;
		const prefixContext = buildNamingRequestContext([], prompt);
		expect(hasSensitiveNamingContext(prefixContext.text)).toBe(false);
		expect(prefixContext.hasSensitiveBoundary()).toBe(true);
		expect(prefixContext.text).toBe(buildNamingContext([], prompt));

		const controlObfuscatedToken = `${token.slice(0, 18)}\u0000${token.slice(18)}`;
		const obfuscatedPrompt = `${"x".repeat(prefixTokenStart)}${controlObfuscatedToken} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

		const historyContent = `${"x".repeat(992)}${token} y`;
		const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
		expect(hasSensitiveNamingContext(history.text)).toBe(false);
		expect(history.hasSensitiveBoundary()).toBe(true);
		const summary = buildNamingRequestContext([
			{ role: "compactionSummary", summary: historyContent },
		] as any);
		expect(hasSensitiveNamingContext(summary.text)).toBe(false);
		expect(summary.hasSensitiveBoundary()).toBe(true);

		const promptLength = MAX_PROMPT_LENGTH + 300;
		const suffixLength = Math.floor(retainedLength / 2);
		const suffixStart = promptLength - suffixLength;
		const suffixTokenStart = suffixStart - token.length + 8;
		const suffixPrompt = `${"x".repeat(suffixTokenStart)}${token} ${"y".repeat(promptLength - suffixTokenStart - token.length - 1)}`;
		const suffixContext = buildNamingRequestContext([], suffixPrompt);
		expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
		expect(suffixContext.hasSensitiveBoundary()).toBe(true);
	}

	const omittedToken = tokens[0]!;
	const omittedPrompt = `${"x".repeat(prefixLength + 20)}${omittedToken} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	for (const shortToken of [`ghp_${"A".repeat(19)}`, `github_pat_${"B".repeat(19)}`]) {
		const shortPrompt = `${"x".repeat(prefixLength - 8)}${shortToken} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], shortPrompt).hasSensitiveBoundary()).toBe(false);
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

test("screens classic AWS access-key IDs across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const token = `AKIA${"A".repeat(16)}`;
	const prefixTokenStart = prefixLength - 8;
	const prompt = `${"x".repeat(prefixTokenStart)}${token} ${"x".repeat(1_200)}`;
	const context = buildNamingRequestContext([], prompt);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);
	expect(context.text).toBe(buildNamingContext([], prompt));

	const controlObfuscated = `${token.slice(0, 8)}\u0000${token.slice(8)}`;
	const obfuscatedPrompt = `${"x".repeat(prefixTokenStart)}${controlObfuscated} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(992)}${token} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: historyContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixLength = Math.floor(retainedLength / 2);
	const suffixStart = promptLength - suffixLength;
	const suffixTokenStart = suffixStart - token.length + 8;
	const suffixPrompt = `${"x".repeat(suffixTokenStart)}${token} ${"y".repeat(promptLength - suffixTokenStart - token.length - 1)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 20)}${token} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	for (const nearMiss of [`AKIA${"A".repeat(15)}`, `AKIX${"A".repeat(16)}`, `akia${"A".repeat(16)}`]) {
		const nearMissPrompt = `${"x".repeat(prefixTokenStart)}${nearMiss} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], nearMissPrompt).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens Google API keys across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const token = `AIza${"A".repeat(35)}`;
	const prefixTokenStart = prefixLength - 8;
	const prompt = `${"x".repeat(prefixTokenStart - 1)} ${token} ${"x".repeat(1_200)}`;
	const context = buildNamingRequestContext([], prompt);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);
	expect(context.text).toBe(buildNamingContext([], prompt));

	const controlObfuscated = `${token.slice(0, 8)}\u0000${token.slice(8)}`;
	const obfuscatedPrompt = `${"x".repeat(prefixTokenStart - 1)} ${controlObfuscated} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(991)} ${token} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: historyContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixLength = Math.floor(retainedLength / 2);
	const suffixStart = promptLength - suffixLength;
	const suffixTokenStart = suffixStart - token.length + 8;
	const suffixPrompt = `${"x".repeat(suffixTokenStart - 1)} ${token} ${"y".repeat(promptLength - suffixTokenStart - token.length - 1)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 19)} ${token} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	for (const nearMiss of [
		`AIza${"A".repeat(34)}`,
		`AIza${"A".repeat(36)}`,
		`AizA${"A".repeat(35)}`,
		`AIza${"A".repeat(17)}!${"A".repeat(17)}`,
	]) {
		const nearMissPrompt = `${"x".repeat(prefixTokenStart - 1)} ${nearMiss} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], nearMissPrompt).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens Google OAuth tokens across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const tokens = [
		`GOCSPX-${"A1b_-".repeat(7)}`,
		`1//${"B2c_-".repeat(7)}`,
		`ya29.${"C3d_-".repeat(7)}`,
	];
	const prefixTokenStart = prefixLength - 8;

	for (const token of tokens) {
		const prompt = `${"x".repeat(prefixTokenStart - 1)} ${token} ${"x".repeat(1_200)}`;
		const context = buildNamingRequestContext([], prompt);
		expect(hasSensitiveNamingContext(context.text)).toBe(false);
		expect(context.hasSensitiveBoundary()).toBe(true);
		expect(context.text).toBe(buildNamingContext([], prompt));

		const controlObfuscated = `${token.slice(0, 8)}\u0000${token.slice(8)}`;
		const obfuscatedPrompt = `${"x".repeat(prefixTokenStart - 1)} ${controlObfuscated} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

		const historyContent = `${"x".repeat(991)} ${token} y`;
		const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
		expect(hasSensitiveNamingContext(history.text)).toBe(false);
		expect(history.hasSensitiveBoundary()).toBe(true);
		const summary = buildNamingRequestContext([
			{ role: "compactionSummary", summary: historyContent },
		] as any);
		expect(hasSensitiveNamingContext(summary.text)).toBe(false);
		expect(summary.hasSensitiveBoundary()).toBe(true);

		const promptLength = MAX_PROMPT_LENGTH + 300;
		const suffixLength = Math.floor(retainedLength / 2);
		const suffixStart = promptLength - suffixLength;
		const suffixTokenStart = suffixStart - token.length + 8;
		const suffixPrompt = `${"x".repeat(suffixTokenStart - 1)} ${token} ${"y".repeat(promptLength - suffixTokenStart - token.length - 1)}`;
		const suffixContext = buildNamingRequestContext([], suffixPrompt);
		expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
		expect(suffixContext.hasSensitiveBoundary()).toBe(true);

		const omittedPrompt = `${"x".repeat(prefixLength + 19)} ${token} ${"y".repeat(3_000)}`;
		expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	}

	for (const nearMiss of [
		`GOCSPX-${"A".repeat(19)}`,
		`1//${"B".repeat(19)}`,
		`ya29.${"C".repeat(19)}`,
		`GOCSPY-${"A".repeat(20)}`,
		`1//${"B".repeat(10)}!${"B".repeat(10)}`,
		`ya28.${"C".repeat(20)}`,
		`x${tokens[0]}`,
	]) {
		const nearMissPrompt = `${"x".repeat(prefixTokenStart - 1)} ${nearMiss} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], nearMissPrompt).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens GitLab personal access tokens across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const token = `glpat-${"A1b_-".repeat(6)}`;
	const prefixTokenStart = prefixLength - 8;
	const prompt = `${"x".repeat(prefixTokenStart - 1)} ${token} ${"x".repeat(1_200)}`;
	const context = buildNamingRequestContext([], prompt);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);
	expect(context.text).toBe(buildNamingContext([], prompt));

	const controlObfuscated = `${token.slice(0, 8)}\u0000${token.slice(8)}`;
	const obfuscatedPrompt = `${"x".repeat(prefixTokenStart - 1)} ${controlObfuscated} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(991)} ${token} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: historyContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixLength = Math.floor(retainedLength / 2);
	const suffixStart = promptLength - suffixLength;
	const suffixTokenStart = suffixStart - token.length + 8;
	const suffixPrompt = `${"x".repeat(suffixTokenStart - 1)} ${token} ${"y".repeat(promptLength - suffixTokenStart - token.length - 1)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 19)} ${token} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	for (const nearMiss of [
		`glpat-${"A".repeat(19)}`,
		`glpatx-${"A".repeat(20)}`,
		`glpat-${"A".repeat(10)}!${"B".repeat(10)}`,
		`GLPAT-${"A".repeat(20)}`,
	]) {
		const nearMissPrompt = `${"x".repeat(prefixTokenStart - 1)} ${nearMiss} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], nearMissPrompt).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens npm access tokens across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const token = `npm_${"A1b2C".repeat(5)}`;
	const prefixTokenStart = prefixLength - 8;
	const prompt = `${"x".repeat(prefixTokenStart - 1)} ${token} ${"x".repeat(1_200)}`;
	const context = buildNamingRequestContext([], prompt);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);
	expect(context.text).toBe(buildNamingContext([], prompt));

	const controlObfuscated = `${token.slice(0, 8)}\u0000${token.slice(8)}`;
	const obfuscatedPrompt = `${"x".repeat(prefixTokenStart - 1)} ${controlObfuscated} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(991)} ${token} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: historyContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixLength = Math.floor(retainedLength / 2);
	const suffixStart = promptLength - suffixLength;
	const suffixTokenStart = suffixStart - token.length + 8;
	const suffixPrompt = `${"x".repeat(suffixTokenStart - 1)} ${token} ${"y".repeat(promptLength - suffixTokenStart - token.length - 1)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 19)} ${token} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	for (const nearMiss of [
		`npm_${"A".repeat(19)}`,
		`npmx_${"A".repeat(20)}`,
		`npm_${"A".repeat(10)}!${"B".repeat(10)}`,
		`NPM_${"A".repeat(20)}`,
	]) {
		const nearMissPrompt = `${"x".repeat(prefixTokenStart - 1)} ${nearMiss} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], nearMissPrompt).hasSensitiveBoundary()).toBe(false);
	}
});

test("screens Hugging Face tokens across retained-context truncation boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const token = `hf_${"A1b2C".repeat(5)}`;
	const prefixTokenStart = prefixLength - 8;
	const prompt = `${"x".repeat(prefixTokenStart - 1)} ${token} ${"x".repeat(1_200)}`;
	const context = buildNamingRequestContext([], prompt);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);
	expect(context.text).toBe(buildNamingContext([], prompt));

	const controlObfuscated = `${token.slice(0, 8)}\u0000${token.slice(8)}`;
	const obfuscatedPrompt = `${"x".repeat(prefixTokenStart - 1)} ${controlObfuscated} ${"x".repeat(1_200)}`;
	expect(buildNamingRequestContext([], obfuscatedPrompt).hasSensitiveBoundary()).toBe(true);

	const historyContent = `${"x".repeat(991)} ${token} y`;
	const history = buildNamingRequestContext([{ role: "user", content: historyContent }] as any);
	expect(hasSensitiveNamingContext(history.text)).toBe(false);
	expect(history.hasSensitiveBoundary()).toBe(true);
	const summary = buildNamingRequestContext([
		{ role: "compactionSummary", summary: historyContent },
	] as any);
	expect(hasSensitiveNamingContext(summary.text)).toBe(false);
	expect(summary.hasSensitiveBoundary()).toBe(true);

	const promptLength = MAX_PROMPT_LENGTH + 300;
	const suffixLength = Math.floor(retainedLength / 2);
	const suffixStart = promptLength - suffixLength;
	const suffixTokenStart = suffixStart - token.length + 8;
	const suffixPrompt = `${"x".repeat(suffixTokenStart - 1)} ${token} ${"y".repeat(promptLength - suffixTokenStart - token.length - 1)}`;
	const suffixContext = buildNamingRequestContext([], suffixPrompt);
	expect(hasSensitiveNamingContext(suffixContext.text)).toBe(false);
	expect(suffixContext.hasSensitiveBoundary()).toBe(true);

	const omittedPrompt = `${"x".repeat(prefixLength + 19)} ${token} ${"y".repeat(3_000)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
	for (const nearMiss of [
		`hf_${"A".repeat(19)}`,
		`hfx_${"A".repeat(20)}`,
		`hf_${"A".repeat(10)}!${"B".repeat(10)}`,
		`HF_${"A".repeat(20)}`,
	]) {
		const nearMissPrompt = `${"x".repeat(prefixTokenStart - 1)} ${nearMiss} ${"x".repeat(1_200)}`;
		expect(buildNamingRequestContext([], nearMissPrompt).hasSensitiveBoundary()).toBe(false);
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

test("screens credential-bearing URI user-info across retained boundaries without flagging no-password URLs", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const promptLength = 3_000;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const url = "postgres://test-user:!examplepassword!!!@db.example.test/app";
	const variants = [
		url,
		`${url.slice(0, 4)}\u0000${url.slice(4)}`,
		`${url.slice(0, 15)}\u200b${url.slice(15)}`,
	];
	const tokenStarts = [prefixLength - 20, suffixStart - 20];

	for (const value of variants) {
		for (const tokenStart of tokenStarts) {
			const prefix = `${"x".repeat(tokenStart - 1)} `;
			const prompt = `${prefix}${value} ${"y".repeat(promptLength - prefix.length - value.length - 1)}`;
			expect(prompt).toHaveLength(promptLength);
			const context = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const noPasswordUrls = [
		"postgres://test-user@localhost/app",
		"redis://:@localhost:6379/0",
		"postgres:/test-user:password@localhost/app",
	];
	for (const value of noPasswordUrls) {
		for (const tokenStart of tokenStarts) {
			const prefix = `${"x".repeat(tokenStart - 1)} `;
			const prompt = `${prefix}${value} ${"y".repeat(promptLength - prefix.length - value.length - 1)}`;
			expect(buildNamingRequestContext([], prompt).hasSensitiveBoundary()).toBe(false);
		}
	}
});

test("screens alternate AWS access IDs and ABSK bearer tokens across retained boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const promptLength = 3_000;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const tokens = [
		`A3TA${"B".repeat(16)}`,
		`A3T7${"C".repeat(16)}`,
		`ABIA${"D".repeat(16)}`,
		`ACCA${"E".repeat(16)}`,
		`ABSK${"A".repeat(109)}`,
		`ABSK${"B".repeat(269)}==`,
	];
	const candidates = tokens.flatMap((token) => [
		token,
		`${token.slice(0, 10)}\u0000${token.slice(10)}`,
	]);
	const tokenStarts = [prefixLength - 10, suffixStart - 10];

	for (const token of candidates) {
		for (const tokenStart of tokenStarts) {
			const prefix = `${"x".repeat(tokenStart - 1)} `;
			const prompt = `${prefix}${token} ${"y".repeat(promptLength - prefix.length - token.length - 1)}`;
			expect(prompt).toHaveLength(promptLength);
			expect(buildNamingRequestContext([], prompt).hasSensitiveBoundary()).toBe(true);
		}
	}

	const nearMisses = [
		`A3TA${"B".repeat(15)}`,
		`ABIA${"C".repeat(16)}x`,
		`prefixACCA${"D".repeat(16)}`,
		`ACCA${"D".repeat(15)}0`,
		`ABSK${"A".repeat(108)}`,
	];
	for (const token of nearMisses) {
		for (const tokenStart of tokenStarts) {
			const prefix = `${"x".repeat(tokenStart - 1)} `;
			const prompt = `${prefix}${token} ${"y".repeat(promptLength - prefix.length - token.length - 1)}`;
			expect(buildNamingRequestContext([], prompt).hasSensitiveBoundary()).toBe(false);
		}
	}
});

test("screens fixed-format Bedrock API-key matches across both retained prompt boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const promptLength = 3_000;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const token = `bedrock-api-key-${Buffer.from("bedrock.amazonaws.com").toString("base64")}`;
	const candidates = [
		token,
		token.replace("bedrock", "bed\u200brock"),
		`${token.slice(0, 22)}\u0000${token.slice(22)}`,
	];
	const tokenStarts = [prefixLength - 10, suffixStart - 10];

	for (const candidate of candidates) {
		expect(hasSensitiveNamingContext(candidate)).toBe(true);
		expect(hasSensitiveOutput(candidate)).toBe(true);
		for (const tokenStart of tokenStarts) {
			const prefix = `${"x".repeat(tokenStart - 1)} `;
			const prompt = `${prefix}${candidate} ${"y".repeat(promptLength - prefix.length - candidate.length - 1)}`;
			expect(prompt).toHaveLength(promptLength);
			const context = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	for (const nearMiss of [token.slice(0, -1), token.slice(0, -1) + "x"]) {
		for (const tokenStart of tokenStarts) {
			const prefix = `${"x".repeat(tokenStart - 1)} `;
			const prompt = `${prefix}${nearMiss} ${"y".repeat(promptLength - prefix.length - nearMiss.length - 1)}`;
			expect(buildNamingRequestContext([], prompt).hasSensitiveBoundary()).toBe(false);
		}
	}

	const omittedTokenStart = prefixLength + 20;
	const omittedPrefix = `${"x".repeat(omittedTokenStart - 1)} `;
	const omittedPrompt = `${omittedPrefix}${token} ${"y".repeat(promptLength - omittedPrefix.length - token.length - 1)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
});

test("screens Sentry organization tokens across both retained prompt boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const promptLength = 3_000;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const firstClaim = "eyJpYXQiO";
	const regionClaims = ["LCJyZWdpb25fdXJs", "InJlZ2lvbl91cmwi", "cmVnaW9uX3VybCI6"];
	const tokenFor = (
		first: string,
		region: string,
		second: string,
		suffix = "C".repeat(43),
		padding = "",
	) => `sntrys_${firstClaim}${first}${region}${second}${padding}_${suffix}`;
	const tokens = regionClaims.map((region) => ({
		region,
		token: tokenFor("a".repeat(20), region, "b".repeat(20)),
	}));
	// Exercise the longest accepted format, which must still fit the boundary scan window.
	tokens.push({
		region: regionClaims[0]!,
		token: tokenFor("a".repeat(200), regionClaims[0]!, "b".repeat(200)),
	});
	tokens.push({
		region: regionClaims[1]!,
		token: tokenFor("a".repeat(20), regionClaims[1]!, "b".repeat(20), "C".repeat(43), "=="),
	});
	const candidates = tokens.flatMap(({ region, token }) => [
		token,
		token.replace("sntrys_", "sntry\u200bs_"),
		token.replace(region, `${region.slice(0, 8)}\u0000${region.slice(8)}`),
	]);
	const tokenStarts = [prefixLength - 10, suffixStart - 10];

	for (const token of candidates) {
		expect(hasSensitiveNamingContext(token)).toBe(true);
		expect(hasSensitiveOutput(token)).toBe(true);
		for (const tokenStart of tokenStarts) {
			const prefix = `${"x".repeat(tokenStart - 1)} `;
			const prompt = `${prefix}${token} ${"y".repeat(promptLength - prefix.length - token.length - 1)}`;
			expect(prompt).toHaveLength(promptLength);
			const context = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	const nearMisses = [
		tokenFor("a".repeat(9), regionClaims[0]!, "b".repeat(20)),
		tokenFor("a".repeat(20), regionClaims[0]!, "b".repeat(9)),
		tokenFor("a".repeat(20), "LCJyZWdpb25fdXls", "b".repeat(20)),
		tokenFor("a".repeat(20), regionClaims[0]!, "b".repeat(20), "C".repeat(42)),
	];
	for (const nearMiss of nearMisses) {
		for (const tokenStart of tokenStarts) {
			const prefix = `${"x".repeat(tokenStart - 1)} `;
			const prompt = `${prefix}${nearMiss} ${"y".repeat(promptLength - prefix.length - nearMiss.length - 1)}`;
			expect(buildNamingRequestContext([], prompt).hasSensitiveBoundary()).toBe(false);
		}
	}

	const omittedToken = tokens[0]!.token;
	const omittedTokenStart = prefixLength + 20;
	const omittedPrefix = `${"x".repeat(omittedTokenStart - 1)} `;
	const omittedPrompt = `${omittedPrefix}${omittedToken} ${"y".repeat(promptLength - omittedPrefix.length - omittedToken.length - 1)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
});

test("screens Fireworks AI tokens across both retained prompt boundaries", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const prefixLength = Math.ceil(retainedLength / 2);
	const promptLength = 3_000;
	const suffixStart = promptLength - Math.floor(retainedLength / 2);
	const tokens = [
		`fw-${"A".repeat(40)}`,
		`fw_${"B".repeat(40)}`,
		`fpk_${"C".repeat(40)}`,
	];
	const candidates = tokens.flatMap((token) => [
		token,
		token.replace(/^(?:fw[-_]|fpk_)/, (prefix) => `${prefix[0]}\u200b${prefix.slice(1)}`),
		`${token.slice(0, 10)}\u0000${token.slice(10)}`,
	]);
	const tokenStarts = [prefixLength - 10, suffixStart - 10];

	for (const token of candidates) {
		expect(hasSensitiveNamingContext(token)).toBe(true);
		expect(hasSensitiveOutput(token)).toBe(true);
		for (const tokenStart of tokenStarts) {
			const prefix = `${"x".repeat(tokenStart - 1)} `;
			const prompt = `${prefix}${token} ${"y".repeat(promptLength - prefix.length - token.length - 1)}`;
			expect(prompt).toHaveLength(promptLength);
			const context = buildNamingRequestContext([], prompt);
			expect(hasSensitiveNamingContext(context.text)).toBe(false);
			expect(context.hasSensitiveBoundary()).toBe(true);
		}
	}

	for (const nearMiss of [`fw-${"A".repeat(19)}`, `fpk_${"B".repeat(19)}`]) {
		for (const tokenStart of tokenStarts) {
			const prefix = `${"x".repeat(tokenStart - 1)} `;
			const prompt = `${prefix}${nearMiss} ${"y".repeat(promptLength - prefix.length - nearMiss.length - 1)}`;
			expect(buildNamingRequestContext([], prompt).hasSensitiveBoundary()).toBe(false);
		}
	}

	const omittedTokenStart = prefixLength + 20;
	const omittedToken = tokens[0]!;
	const omittedPrefix = `${"x".repeat(omittedTokenStart - 1)} `;
	const omittedPrompt = `${omittedPrefix}${omittedToken} ${"y".repeat(promptLength - omittedPrefix.length - omittedToken.length - 1)}`;
	expect(buildNamingRequestContext([], omittedPrompt).hasSensitiveBoundary()).toBe(false);
});

test("long variable-length tokens stay detectable when a retained suffix starts mid-token", () => {
	const marker = "[... middle of prompt omitted ...]";
	const retainedLength = MAX_PROMPT_LENGTH - marker.length - 2;
	const suffixLength = Math.floor(retainedLength / 2);
	const promptLength = 6_000;
	const suffixStart = promptLength - suffixLength;
	const token = `fm2_${"A".repeat(1_100)}`;
	const tokenStart = suffixStart - 800;
	const prompt = `${"x".repeat(tokenStart - 1)} ${token}${"x".repeat(promptLength - tokenStart - token.length)}`;
	const context = buildNamingRequestContext([], prompt);

	expect(prompt).toHaveLength(promptLength);
	expect(hasSensitiveNamingContext(context.text)).toBe(false);
	expect(context.hasSensitiveBoundary()).toBe(true);

	const omittedTokenStart = 1_500;
	const omittedPrompt = `${"x".repeat(omittedTokenStart - 1)} ${token}`
		+ `${"x".repeat(promptLength - omittedTokenStart - token.length)}`;
	const omittedContext = buildNamingRequestContext([], omittedPrompt);
	expect(hasSensitiveNamingContext(omittedContext.text)).toBe(false);
	expect(omittedContext.hasSensitiveBoundary()).toBe(false);
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
