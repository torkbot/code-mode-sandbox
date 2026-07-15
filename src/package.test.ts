import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package publishes the Sandbox integration against released contracts", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    readonly dependencies: Readonly<Record<string, string>>;
    readonly exports: Readonly<Record<string, unknown>>;
    readonly files: readonly string[];
  };
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

  assert.equal(packageJson.dependencies["@torkbot/code-mode"], "^0.1.0");
  assert.equal(packageJson.dependencies["@torkbot/sandbox"], "^0.14.0");
  assert.deepEqual(Object.keys(packageJson.exports), ["."]);
  assert.deepEqual(packageJson.files, ["dist"]);
  assert.match(source, /from "@torkbot\/code-mode\/node"/);
  assert.match(source, /export function createSandboxNodeRuntimeHost/);
  assert.doesNotMatch(source, /extends Node24Runtime/);
  assert.doesNotMatch(source, /@torkbot\/code-mode\/sandbox-node/);
});
