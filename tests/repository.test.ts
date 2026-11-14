import { expect, test } from "bun:test";
import { JSONC } from "bun";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { assertDefined } from "./assert-defined.ts";
import { cleanupTmuxFixture, supportsUnixTmux } from "./tmux-support.ts";

const WORKFLOWS_DIRECTORY = fileURLToPath(
  new URL("../.github/workflows/", import.meta.url),
);

test("tmux integration fixtures require a Unix-like platform and a tmux executable", () => {
  expect(supportsUnixTmux("win32", "C:\\tools\\tmux.exe")).toBe(false);
  expect(supportsUnixTmux("linux", "/usr/bin/tmux")).toBe(true);
  expect(supportsUnixTmux("darwin", null)).toBe(false);
});

test("tmux fixture cleanup does not mask a test failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-tmux-cleanup-test-"));
  const failure = new Error("fixture failed");
  let observed: unknown;
  try {
    try {
      throw failure;
    } finally {
      cleanupTmuxFixture(() => {
        throw new Error("server already exited");
      }, directory);
    }
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(failure);
  expect(existsSync(directory)).toBe(false);

  try {
    try {
      throw failure;
    } finally {
      cleanupTmuxFixture(() => undefined, "\0");
    }
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(failure);
});

test("README uses the shared section structure, resolves Contents anchors, and uses absolute links", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const contents = /^## Contents\n([\s\S]*?)(?=^## )/m.exec(readme)?.[1];
  if (!contents)
    throw new Error(
      "README must include a Contents section before its main sections",
    );

  expect(readme).toContain(
    "Name tmux windows after your current Pi task and mark the ones waiting for your input.",
  );
  expect(readme).toContain(
    "A prompt about fixing authentication tests might produce `fix auth tests`.",
  );
  expect(readme).toContain("| Pi has settled and is waiting for input");

  const occurrences = new Map<string, number>();
  const headingAnchors = new Set(
    [...readme.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map(([, heading]) => {
      const slug = assertDefined(heading)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .trim()
        .replace(/\s+/gu, "-")
        .replace(/-+/gu, "-");
      const occurrence = occurrences.get(slug) ?? 0;
      occurrences.set(slug, occurrence + 1);
      return occurrence === 0 ? slug : `${slug}-${String(occurrence)}`;
    }),
  );
  const anchors = [...contents.matchAll(/\]\(#([^)]*)\)/gu)].map(([, anchor]) =>
    assertDefined(anchor),
  );
  expect(anchors.length).toBeGreaterThan(0);
  expect(anchors.filter((anchor) => !headingAnchors.has(anchor))).toEqual([]);

  expect(
    [...readme.matchAll(/^## (.+?)\s*$/gm)].map(([, heading]) =>
      assertDefined(heading),
    ),
  ).toEqual([
    "Contents",
    "Installation",
    "Usage",
    "How it works",
    "Configuration",
    "Compatibility",
    "Privacy and security",
    "Troubleshooting",
    "More Pi extensions",
    "Contributing",
    "License",
  ]);

  const destinations = [...readme.matchAll(/\]\(([^)]+)\)/gu)].map(
    ([, destination]) => assertDefined(destination),
  );
  expect(
    destinations.filter(
      (destination) =>
        !destination.startsWith("#") && !/^https?:\/\//iu.test(destination),
    ),
  ).toEqual([]);
  const referenceDestinations = [
    ...readme.matchAll(/^\[[^\]]+\]:\s*(\S+)/gmu),
  ].map(([, destination]) => assertDefined(destination));
  expect(
    referenceDestinations.filter(
      (destination) => !/^https?:\/\//iu.test(destination),
    ),
  ).toEqual([]);
});

test("README tmux compatibility versions stay aligned with version-checked CI", () => {
  const setup = readFileSync(
    fileURLToPath(
      new URL("../.github/scripts/setup-test-tools.sh", import.meta.url),
    ),
    "utf8",
  );
  const workflow = readFileSync(
    fileURLToPath(new URL("../.github/workflows/ci.yaml", import.meta.url)),
    "utf8",
  );
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
  expect(setup).toContain('tmux -V | grep -Fx "tmux 3.4"');
  expect(workflow).toContain('test "$(tmux -V)" = "tmux 3.7c"');
  expect(readme).toMatch(
    /Linux CI tests tmux 3\.4 and a pinned tmux 3\.7c build;\s*macOS CI uses Homebrew\s+tmux\./u,
  );
});

test("README's tested Pi version matches the development SDK", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    devDependencies: Record<string, string>;
  };
  expect(readme).toContain(
    `Tested with Pi ${String(manifest.devDependencies["@earendil-works/pi-coding-agent"])}`,
  );
  expect(readme.replace(/\s+/gu, " ")).toContain(
    "It accepts any Pi version as its extension API peer (`*`), so it always uses the Pi that loads it.",
  );
});

test("CI tests the minimum supported Pi from engines.pi without changing the lockfile", () => {
  interface Step {
    run?: string;
  }
  const workflow = parseYaml(
    readFileSync(
      fileURLToPath(new URL("../.github/workflows/ci.yaml", import.meta.url)),
      "utf8",
    ),
  ) as {
    jobs?: Record<string, { steps?: Step[] }>;
  };
  const runs = (workflow.jobs?.["pi-min"]?.steps ?? []).map(
    (step) => step.run ?? "",
  );
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    engines: { pi?: string };
  };
  const minimumVersion = /^>=(\d+\.\d+\.\d+)$/u.exec(
    manifest.engines.pi ?? "",
  )?.[1];
  if (!minimumVersion)
    throw new Error(
      `Expected engines.pi to be ">=x.y.z", got ${String(manifest.engines.pi)}`,
    );
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\s+/gu, " ");

  expect(runs).toContain("bun .github/scripts/install-pi.ts min");
  expect(runs.indexOf("bun run test")).toBeGreaterThan(
    runs.indexOf("bun .github/scripts/install-pi.ts min"),
  );
  expect(runs).toContain("git diff --exit-code -- package.json bun.lock");
  expect(readme).toContain(
    `CI also checks the minimum supported Pi ${minimumVersion}.`,
  );
});

test("CI tests the declared minimum Node.js version", () => {
  const workflow = parseYaml(
    readFileSync(
      fileURLToPath(new URL("../.github/workflows/ci.yaml", import.meta.url)),
      "utf8",
    ),
  ) as {
    jobs?: Record<
      string,
      { strategy?: { matrix?: { node?: (string | number)[] } } }
    >;
  };
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    engines: { node: string };
  };
  const minimumVersion = /^>=(\d+\.\d+\.\d+)$/u.exec(
    manifest.engines.node,
  )?.[1];
  if (!minimumVersion)
    throw new Error(
      `Expected a minimum Node.js engine version, got ${manifest.engines.node}`,
    );

  expect(workflow.jobs?.node?.strategy?.matrix?.node?.map(String)).toContain(
    minimumVersion,
  );
});

test("README documents the bounded manual and idle-title input limit", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\s+/gu, " ");
  expect(readme).toContain("values longer than 64 Ki UTF-16 code units");
  expect(readme).toContain(
    "Inputs longer than 64 Ki UTF-16 code units are rejected before screening",
  );
});

test("README cites J-LIS for the Japanese My Number checksum rule", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\s+/gu, " ");
  expect(readme).toContain("J-LIS check-digit rule (Japanese PDF)");
  expect(readme).toContain(
    "https://www.j-lis.go.jp/data/open/cnt/3/1282/1/H2707_qa.pdf",
  );
});

test("README cites INSEE for Corsican NIR check-key support", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\s+/gu, " ");
  expect(readme).toContain("Corsican `2A`/`2B` department codes");
  expect(readme).toContain("https://xml.insee.fr/schema/nir.html");
});

test("README cites the Ministry of the Interior for Spanish DNI/NIE checks", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\s+/gu, " ");
  expect(readme).toContain("Ministry of the Interior control-digit guide");
  expect(readme).toContain(
    "https://www.interior.gob.es/opencms/en/servicios-al-ciudadano/tramites-y-gestiones/dni/calculo-del-digito-de-control-del-nif-nie/",
  );
});

test("README cites the NHS Data Dictionary for NHS number validation", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\s+/gu, " ");
  expect(readme).toContain("10 digits and a valid Modulus 11 check digit");
  expect(readme).toContain(
    "https://www.datadictionary.nhs.uk/attributes/nhs_number.html",
  );
});

test("README cites Skatteverket for Swedish personal-number checks", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\s+/gu, " ");
  expect(readme).toContain("Skatteverket's Modulus 10 method");
  expect(readme).toContain("alternating weights 1 and 2");
  expect(readme).toContain(
    "https://www4.skatteverket.se/rattsligvagledning/edition/2026.6/330245.html",
  );
});

test("README cites the ATO for local TFN screening limitations", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\s+/gu, " ");
  expect(readme).toContain("local weighted Modulus 11 checksum pattern");
  expect(readme).toContain(
    "best-effort screening and does not confirm ATO issuance",
  );
  expect(readme).toContain(
    "software developers may request its TFN validation algorithm",
  );
  expect(readme).toContain(
    "https://www.ato.gov.au/tax-and-super-professionals/for-superannuation-professionals/apra-regulated-funds/managing-member-benefits/taxation-of-member-super-benefits/tax-file-numbers-and-super-contributions/obtaining-member-tfns",
  );
});

test("README cites Inland Revenue for the current New Zealand IRD range", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\s+/gu, " ");
  expect(readme).toContain("up to 200,000,000");
  expect(readme).toContain("2026 increase to the validation ceiling");
  expect(readme).toContain(
    "https://www.ird.govt.nz/updates/news-folder/2026/increase-to-ird-number-validation-upper-limit",
  );
});

test("CONTRIBUTING documents current privacy screening test coverage", () => {
  const contributorGuide = readFileSync(
    fileURLToPath(new URL("../CONTRIBUTING.md", import.meta.url)),
    "utf8",
  ).replace(/\s+/gu, " ");
  expect(contributorGuide).toContain(
    "explicitly labeled personal-data screening",
  );
  expect(contributorGuide).toContain(
    "Unicode variants, near-misses, and retained-context-boundary cases",
  );
  expect(contributorGuide).toContain(
    "context is screened before model-registry access without echoing matches",
  );
  expect(contributorGuide).toContain(
    "sensitive-looking context is not sent to the model",
  );
  expect(contributorGuide).toContain(
    "sensitive-looking output is neither applied nor disclosed",
  );
  expect(contributorGuide).toContain("identifier examples are synthetic");
  expect(contributorGuide).toContain(
    "runtime-supported decimal digit mappings",
  );
  expect(contributorGuide).toContain(
    "conservative handling of unmappable digits",
  );
});

test("README distinguishes shared title updates from status-only markers", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\s+/gu, " ");
  expect(readme).toContain(
    "Waiting-marker updates alone preserve the current shared title instead of replaying a stale per-pane title",
  );
  expect(readme).toContain(
    "a new AI result, manual pin, or explicit `/tmux-title sync` can replace it",
  );
});

test("README specifies UTF-16 code-unit limits for naming context sent to the model", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\s+/gu, " ");
  expect(readme).toContain("up to 6,000 UTF-16 code units of task context");
  expect(readme).toContain("a supplementary Unicode character counts as two");
  expect(readme).toContain(
    "Up to 2,000 UTF-16 code units from your new prompt",
  );
  expect(readme).toContain("capped at 1,000 UTF-16 code units");
  expect(readme).toContain("truncation keeps such characters intact");
});

test("CI history secret scanning verifies its pinned binary and redacts findings", () => {
  interface Step {
    run?: string;
    with?: Record<string, unknown>;
  }
  const workflow = parseYaml(
    readFileSync(
      fileURLToPath(new URL("../.github/workflows/ci.yaml", import.meta.url)),
      "utf8",
    ),
  ) as {
    jobs?: Record<string, { steps?: Step[] }>;
  };
  const steps = workflow.jobs?.static?.steps ?? [];
  const checkout = steps.find(
    (step) => step.with?.["fetch-depth"] !== undefined,
  );
  const script = readFileSync(
    fileURLToPath(
      new URL("../.github/scripts/check-workflows.sh", import.meta.url),
    ),
    "utf8",
  );

  expect(checkout?.with?.["fetch-depth"]).toBe(0);
  expect(
    steps.some(
      (step) => step.run === "bash .github/scripts/check-workflows.sh",
    ),
  ).toBe(true);
  expect(script).toMatch(/gitleaks_\d+\.\d+\.\d+_linux_x64\.tar\.gz/u);
  expect(script).toMatch(
    /printf '%s {2}%s\\n' [a-f0-9]{64} "\$directory\/gitleaks\.tar\.gz" \| sha256sum --check --status/u,
  );
  const checksum = script.indexOf(
    'gitleaks.tar.gz" | sha256sum --check --status',
  );
  const extraction = script.indexOf('tar -xzf "$directory/gitleaks.tar.gz"');
  const execution = script.indexOf(
    '"$directory/gitleaks" git --redact --no-banner .',
  );
  expect(checksum).toBeGreaterThanOrEqual(0);
  expect(extraction).toBeGreaterThan(checksum);
  expect(execution).toBeGreaterThan(extraction);
});

test("README offers npm installation", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  ).replace(/\s+/gu, " ");
  expect(readme).toContain("The npm package is available:");
  expect(readme).toContain("pi install npm:@leocavalcante/pi-tmux");
  expect(readme).not.toContain("npm package has not been published yet");
});

test("local verify script runs the same validation gates as CI", () => {
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    scripts?: Record<string, string>;
  };
  interface Step {
    run?: string;
  }
  const workflow = parseYaml(
    readFileSync(
      fileURLToPath(new URL("../.github/workflows/ci.yaml", import.meta.url)),
      "utf8",
    ),
  ) as {
    jobs?: Record<string, { steps?: Step[] }>;
  };
  const runs = (job: string) =>
    (workflow.jobs?.[job]?.steps ?? []).map((step) => step.run);

  expect(manifest.scripts?.["check:package"]).toBe(
    "bun run changelog && publint && node .github/scripts/check-package.mjs",
  );
  expect(manifest.scripts?.verify).toBe(
    [
      "bun run lint",
      "bun run check",
      "bun run test",
      "bun run check:package",
      "bun audit --audit-level=high",
    ].join(" && "),
  );
  expect(runs("static")).toEqual(
    expect.arrayContaining([
      "bun run lint",
      "bun run check",
      "bun audit --audit-level=high",
    ]),
  );
  expect(runs("test")).toContain("bun run test");
  expect(runs("package")).toContain("bun run check:package");
});

test("the package test command runs native Node subprocess coverage", () => {
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    scripts?: Record<string, string>;
  };
  expect(manifest.scripts?.test).toBe("bun run test:bun && bun run test:node");
  expect(manifest.scripts?.["test:node"]).toBe(
    "node --import jiti/register --test --test-concurrency=1 tests/*.node-test.ts",
  );
});

test("@types/node stays pinned to 22.20.5 in the manifest and lockfile", () => {
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    devDependencies?: Record<string, string>;
  };
  const lockfile = JSONC.parse(
    readFileSync(
      fileURLToPath(new URL("../bun.lock", import.meta.url)),
      "utf8",
    ),
  ) as {
    workspaces?: Record<string, { devDependencies?: Record<string, string> }>;
    packages?: Record<string, [string, ...unknown[]]>;
  };
  const pinnedVersion = "22.20.5";

  expect(manifest.devDependencies?.["@types/node"]).toBe(pinnedVersion);
  expect(lockfile.workspaces?.[""]?.devDependencies?.["@types/node"]).toBe(
    pinnedVersion,
  );
  expect(lockfile.packages?.["@types/node"]?.[0]).toBe(
    `@types/node@${pinnedVersion}`,
  );
});

test("external GitHub Actions use full commit SHAs with version comments", () => {
  const workflowFiles = readdirSync(WORKFLOWS_DIRECTORY)
    .filter((file) => /\.ya?ml$/i.test(file))
    .sort();
  let checkedActions = 0;

  for (const file of workflowFiles) {
    const contents = readFileSync(
      fileURLToPath(new URL(`../.github/workflows/${file}`, import.meta.url)),
      "utf8",
    );
    const lines = contents.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const match = /^\s*(?:-\s+)?uses:\s*([^\s#]+)(?:\s+#\s*(.*))?\s*$/.exec(
        line,
      );
      if (!match) continue;
      const reference = assertDefined(match[1]);
      const versionComment = match[2];
      if (reference.startsWith("./")) continue;
      checkedActions++;
      if (!/^[^@]+@[0-9a-f]{40}$/.test(reference)) {
        throw new Error(
          `${file}:${String(index + 1)}: pin external action to a full commit SHA: ${reference}`,
        );
      }
      if (!versionComment?.startsWith("v")) {
        throw new Error(
          `${file}:${String(index + 1)}: retain a version comment for Dependabot: ${reference}`,
        );
      }
    }
  }

  expect(checkedActions).toBeGreaterThan(0);
});
