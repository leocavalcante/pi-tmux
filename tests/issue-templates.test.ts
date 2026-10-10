import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

type RecordValue = Record<string, unknown>;

const TEMPLATE_DIRECTORY = new URL("../.github/ISSUE_TEMPLATE/", import.meta.url);

function readYaml(path: string): unknown {
	const source = readFileSync(fileURLToPath(new URL(path, TEMPLATE_DIRECTORY)), "utf8");
	const document = parseDocument(source, { uniqueKeys: true });
	if (document.errors.length) throw new Error(`${path} is not valid YAML`);
	return document.toJS() as unknown;
}

function requireRecord(value: unknown, description: string): RecordValue {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${description} must be a mapping`);
	}
	return value as RecordValue;
}

function requireString(value: unknown, description: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${description} must be a non-empty string`);
	return value;
}

function validateForm(path: string): { name: string; fields: RecordValue[] } {
	const form = requireRecord(readYaml(path), path);
	const name = requireString(form.name, `${path} name`);
	requireString(form.description, `${path} description`);
	if (form.title !== undefined) requireString(form.title, `${path} title`);
	if (!Array.isArray(form.body) || form.body.length < 1 || form.body.length > 10) {
		throw new Error(`${path} must have between 1 and 10 body fields`);
	}

	const ids = new Set<string>();
	const fields = form.body.map((value, index) => {
		const field = requireRecord(value, `${path} body[${index}]`);
		const type = requireString(field.type, `${path} body[${index}] type`);
		if (!["markdown", "input", "textarea", "dropdown", "checkboxes", "upload"].includes(type)) {
			throw new Error(`${path} body[${index}] uses an unsupported form field type`);
		}
		const attributes = requireRecord(field.attributes, `${path} body[${index}] attributes`);
		if (type === "markdown") {
			requireString(attributes.value, `${path} body[${index}] markdown value`);
		} else {
			const id = requireString(field.id, `${path} body[${index}] id`);
			if (!/^[a-z0-9-]+$/.test(id) || ids.has(id)) throw new Error(`${path} has an invalid or duplicate field id`);
			ids.add(id);
			requireString(attributes.label, `${path} body[${index}] label`);
		}
		if (type === "dropdown" || type === "checkboxes") {
			if (!Array.isArray(attributes.options) || attributes.options.length === 0
				|| attributes.options.some((option) => typeof option !== "string" || !option.trim())) {
				throw new Error(`${path} body[${index}] must have non-empty options`);
			}
		}
		if (field.validations !== undefined) {
			const validations = requireRecord(field.validations, `${path} body[${index}] validations`);
			if (validations.required !== undefined && typeof validations.required !== "boolean") {
				throw new Error(`${path} body[${index}] required must be boolean`);
			}
		}
		return field;
	});

	return { name, fields };
}

function privacyNotice(form: { name: string; fields: RecordValue[] }): string {
	const notices = form.fields
		.filter((field) => field.type === "markdown")
		.map((field) => requireRecord(field.attributes, `${form.name} markdown attributes`).value)
		.filter((value): value is string => typeof value === "string");
	if (notices.length === 0) throw new Error(`${form.name} must include a privacy reminder`);
	return notices.join("\n").toLowerCase();
}

test("GitHub issue forms use parseable YAML and supported, uniquely identified fields", () => {
	const bug = validateForm("bug_report.yml");
	const feature = validateForm("feature_request.yml");

	expect(bug.name).toBe("Bug report");
	expect(feature.name).toBe("Feature request");
	expect(bug.fields.some((field) => field.id === "operating-system" && field.type === "dropdown")).toBe(true);
	expect(bug.fields.some((field) => field.id === "ai-naming" && field.type === "dropdown")).toBe(true);
});

test("both issue forms give clear privacy reminders without promising comprehensive screening", () => {
	for (const form of [validateForm("bug_report.yml"), validateForm("feature_request.yml")]) {
		const notice = privacyNotice(form);
		for (const detail of ["credentials", "prompts", "conversation history", "private window/session titles", "generated or redacted examples"]) {
			expect(notice).toContain(detail);
		}
		for (const claim of [
			"comprehensive redaction",
			"comprehensive screening",
			"fully redacted",
			"all credentials are removed",
			"all sensitive data is removed",
			"guaranteed private",
		]) {
			expect(notice).not.toContain(claim);
		}
	}
	expect(privacyNotice(validateForm("bug_report.yml"))).toContain("best-effort");
});

test("blank issues remain enabled", () => {
	const config = requireRecord(readYaml("config.yml"), "issue template config");
	expect(config.blank_issues_enabled).toBe(true);
});
