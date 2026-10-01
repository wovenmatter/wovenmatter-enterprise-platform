import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
async function discover(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? discover(resolve(path, entry.name))
        : entry.name.endsWith(".test.js")
          ? [resolve(path, entry.name)]
          : [],
    ),
  );
  return nested.flat();
}
const files = [
  ...(await discover(resolve("platform/dist/tests"))),
  ...(await discover(resolve("platform/dist/packages/runtime/test"))),
];
if (!files.length) throw new Error("No compiled platform tests discovered");
files.push(resolve("platform/runtime/fixture-cleanup.test.mjs"));
files.sort();
const coverage = process.argv.includes("--coverage");
if (coverage) await mkdir("coverage", { recursive: true });
const coverageArgs = coverage ? [
  "--experimental-test-coverage",
  ...[
    "**/platform/dist/apps/**",
    "**/platform/dist/packages/runtime/src/**",
    "**/platform/dist/deploy/**",
    "**/platform/runtime/fixture-cleanup.mjs",
    "**/platform/scripts/sqlite-backup.mjs",
  ].map((pattern) => `--test-coverage-include=${pattern}`),
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
  "--test-reporter=lcov",
  "--test-reporter-destination=coverage/lcov.info",
] : [];
const child = spawn(
  process.execPath,
  ["--test", "--test-concurrency=4", ...coverageArgs, ...files],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));
