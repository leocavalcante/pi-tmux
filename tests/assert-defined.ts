import assert from "node:assert/strict";

export function assertDefined<T>(value: T): NonNullable<T> {
  assert.ok(
    value !== undefined && value !== null,
    "Expected the value to exist",
  );
  return value;
}
