import { expect, test } from "bun:test";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { parseNamingModel } from "../src/naming.ts";

test("default naming model exists in Pi's built-in catalog", () => {
	const model = parseNamingModel();
	expect(model).not.toBeNull();
	if (!model) return;

	expect(model.provider).toBe("openai-codex");
	const catalogModel = Object.values(OPENAI_CODEX_MODELS).find((candidate) => candidate.id === model.id);
	expect(catalogModel).toBeDefined();
	expect(catalogModel?.provider).toBe("openai-codex");
});
