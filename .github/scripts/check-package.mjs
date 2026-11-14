import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const directory = mkdtempSync(join(tmpdir(), "pi-tmux-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const options = {
  encoding: "utf8",
  timeout: 180000,
  shell: process.platform === "win32",
};
try {
  const output = execFileSync(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
    options,
  );
  const records = JSON.parse(output);
  const packages = Array.isArray(records) ? records : Object.values(records);
  assert.equal(packages.length, 1);
  const packed = packages[0];
  const paths = packed.files.map((file) => file.path);
  for (const required of [
    "index.ts",
    "src/extension.ts",
    "src/tmux.ts",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
  ]) {
    assert(paths.includes(required), `Missing published file: ${required}`);
  }
  assert(
    !paths.some((path) => /^(?:tests|node_modules|\.github|docs)\//.test(path)),
  );
  assert(
    !paths.some((path) =>
      /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials[^/]*)$/.test(path),
    ),
  );

  // Install like Pi does, then load the TypeScript entry through jiti.
  const consumer = join(directory, "consumer");
  execFileSync(
    npm,
    [
      "install",
      "--prefix",
      consumer,
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      join(directory, packed.filename),
      `jiti@${manifest.devDependencies.jiti}`,
    ],
    { ...options, stdio: "inherit" },
  );
  const installed = JSON.parse(
    readFileSync(
      join(consumer, "node_modules/@leocavalcante/pi-tmux/package.json"),
      "utf8",
    ),
  );
  assert.equal(installed.version, manifest.version);

  const extension = join(consumer, "extension.mjs");
  writeFileSync(
    extension,
    `
    import assert from "node:assert/strict";
    const loaded = await import("@leocavalcante/pi-tmux/index.ts");
    // jiti exposes TypeScript in node_modules through CommonJS interop; Pi unwraps it the same way.
    const register = typeof loaded.default === "function" ? loaded.default : loaded.default.default;
    assert.equal(typeof register, "function");
    const commands = [];
    register({ registerCommand: name => commands.push(name), on() {} });
    assert.deepEqual(commands, ["tmux-title", "quit-pane"]);
    console.log("Packed extension loads under Node.js through jiti.");
  `,
  );
  execFileSync(process.execPath, ["--import", "jiti/register", extension], {
    cwd: consumer,
    timeout: 30000,
    stdio: "inherit",
  });
  console.log(
    `Validated ${packed.filename}: ${paths.length} allowlisted files.`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
