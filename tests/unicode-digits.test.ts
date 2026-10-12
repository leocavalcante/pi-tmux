import { expect, test } from "bun:test";
import { asciiDecimalDigits, conservativelyValidateLabeledDigits } from "../src/unicode-digits.ts";

test("normalizes supported Unicode decimal digits for checksum validation", () => {
	expect(asciiDecimalDigits("١２३")).toBe("123");
});

test("normalizes every Unicode decimal digit recognized by the runtime", () => {
	const decimalDigit = /^\p{Nd}$/u;
	let rangeStart = -1;
	let expected = "";
	let actual = "";
	for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
		const character = String.fromCodePoint(codePoint);
		if (!decimalDigit.test(character)) {
			rangeStart = -1;
			continue;
		}
		if (rangeStart < 0) rangeStart = codePoint;
		expected += (codePoint - rangeStart) % 10;
		actual += asciiDecimalDigits(character) ?? "?";
	}
	expect(actual).toBe(expected);
});

test("treats an unmappable Unicode decimal digit as a possible labeled identifier", () => {
	const digits = asciiDecimalDigits("123456789", () => undefined);
	expect(digits).toBeUndefined();
	expect(conservativelyValidateLabeledDigits(digits, () => false)).toBe(true);
});

test("still rejects known digits that fail identifier validation", () => {
	const digits = asciiDecimalDigits("123456789");
	expect(conservativelyValidateLabeledDigits(digits, () => false)).toBe(false);
});
