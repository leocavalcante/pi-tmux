import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

test("the extension loads on Node.js and registers its commands and hooks", () => {
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    registerCommand(name: string) {
      commands.push(name);
    },
    on(event: string) {
      events.push(event);
    },
  };

  // Only registration methods exist on the fake API: loading must not run tmux,
  // read the session, or call a model.
  extension(pi as unknown as ExtensionAPI);

  assert.deepEqual(commands, ["tmux-title", "quit-pane"]);
  assert.deepEqual([...new Set(events)].sort(), [
    "agent_settled",
    "agent_start",
    "input",
    "session_before_compact",
    "session_compact",
    "session_compact_failed",
    "session_shutdown",
    "session_start",
    "session_tree",
  ]);
});
