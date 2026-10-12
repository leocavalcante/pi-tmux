import { expect, test } from "bun:test";
import { asciiDecimalDigits, conservativelyValidateLabeledDigits } from "../src/unicode-digits.ts";

test("normalizes supported Unicode decimal digits for checksum validation", () => {
	expect(asciiDecimalDigits("١２३")).toBe("123");
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
