// Unicode 17 decimal-digit zero code points; digits 0–9 follow each zero.
// Keep the table explicit because JavaScript has no decimal-digit value property.
const UNICODE_DECIMAL_DIGIT_PATTERN = /\p{Nd}/u;
const UNICODE_DECIMAL_DIGIT_ZEROES = [
	0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6,
	0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0,
	0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80,
	0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900,
	0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30, 0x10d40,
	0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650,
	0x116c0, 0x116d0, 0x116da, 0x11730, 0x118e0, 0x11950, 0x11bf0, 0x11c50,
	0x11d50, 0x11da0, 0x11de0, 0x11f50, 0x16130, 0x16a60, 0x16ac0, 0x16b50,
	0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140,
	0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0,
];

function decimalDigitValue(character: string): number | undefined {
	const codePoint = character.codePointAt(0)!;
	let low = 0;
	let high = UNICODE_DECIMAL_DIGIT_ZEROES.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const zero = UNICODE_DECIMAL_DIGIT_ZEROES[middle]!;
		if (codePoint < zero) high = middle - 1;
		else if (codePoint >= zero + 10) low = middle + 1;
		else return codePoint - zero;
	}
	return undefined;
}

export function asciiDecimalDigits(
	value: string,
	getDigitValue: (character: string) => number | undefined = decimalDigitValue,
): string | undefined {
	let digits = "";
	for (const character of value) {
		if (!UNICODE_DECIMAL_DIGIT_PATTERN.test(character)) continue;
		const digit = getDigitValue(character);
		// The caller can conservatively reject the candidate if a newer runtime
		// recognizes a decimal digit missing from this table.
		if (digit === undefined) return undefined;
		digits += digit;
	}
	return digits;
}

// Call only after an explicit identifier label and digit-shape match. If the
// runtime knows a digit that this table cannot map, don't silently allow it.
export function conservativelyValidateLabeledDigits(
	digits: string | undefined,
	validateKnownDigits: (digits: string) => boolean,
): boolean {
	return digits === undefined || validateKnownDigits(digits);
}
