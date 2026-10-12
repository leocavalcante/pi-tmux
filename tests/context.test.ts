import { expect, test } from "bun:test";
import { buildNamingContext } from "../src/naming.ts";

test("large session projections only inspect the bounded recent-history window", () => {
	const messageCount = 5_000;
	const scanLimit = 4_096;
	const oldestScannedIndex = messageCount - scanLimit;
	const messages = Array.from({ length: messageCount }, (_, index) => ({
		role: "user",
		content: `message ${index}`,
	}));
	Object.defineProperty(messages[0]!, "content", {
		get() { throw new Error("The oldest message content should not be read"); },
	});

	const guardedMessages = new Proxy(messages, {
		get(target, property, receiver) {
			if (typeof property === "string" && /^[1-9]\d*$/u.test(property)) {
				const index = Number(property);
				if (index < oldestScannedIndex) {
					throw new Error(`Read history outside the recent scan window at index ${index}`);
				}
			}
			return Reflect.get(target, property, receiver);
		},
	});

	const context = buildNamingContext(guardedMessages as any);
	for (let index = messageCount - 8; index < messageCount; index++) {
		expect(context).toContain(`user: message ${index}`);
	}
	expect(context).not.toContain("message 0");
});
