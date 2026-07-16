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
    readonly version: string;
  };
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

  assert.equal(packageJson.dependencies["@torkbot/code-mode"], "^0.2.0");
  assert.equal(packageJson.dependencies["@torkbot/sandbox"], "^0.14.0");
  assert.equal(packageJson.version, "0.0.0-dev");
  assert.deepEqual(Object.keys(packageJson.exports), ["."]);
  assert.deepEqual(packageJson.files, ["dist"]);
  assert.match(source, /from "@torkbot\/code-mode\/node"/);
  assert.match(source, /export function createSandboxNodeRuntime/);
  assert.doesNotMatch(source, /export function createSandboxNodeRuntimeHost/);
  assert.doesNotMatch(source, /extends Node24Runtime/);
  assert.doesNotMatch(source, /WebByteWriter|readableChunks/);
  assert.doesNotMatch(source, /@torkbot\/code-mode\/sandbox-node/);
});

test("release workflow derives metadata from the tag and reuses the exact-main payload", async () => {
  const ciWorkflow = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const releaseWorkflow = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const manifestScript = await readFile(
    new URL("../scripts/release-artifact-manifest.ts", import.meta.url),
    "utf8",
  );

  assert.match(ciWorkflow, /Build immutable package payload/);
  assert.match(ciWorkflow, /release-artifact-manifest\.ts write/);
  assert.doesNotMatch(ciWorkflow, /--package-version/);
  assert.match(releaseWorkflow, /package_version="\$\{RELEASE_TAG#v\}"/);
  assert.match(releaseWorkflow, /download-release-artifact\.ts --target-sha/);
  assert.match(releaseWorkflow, /release-artifact-manifest\.ts verify/);
  assert.match(releaseWorkflow, /tar -xzf/);
  assert.match(releaseWorkflow, /npm version "\$PACKAGE_VERSION"/);
  assert.match(releaseWorkflow, /--no-git-tag-version/);
  assert.match(
    releaseWorkflow,
    /test "\$actual_version" = "\$PACKAGE_VERSION"/,
  );
  assert.match(releaseWorkflow, /npm pack dist\/release-staging\/package/);
  assert.match(
    releaseWorkflow,
    /npm publish dist\/release\/\*\.tgz --ignore-scripts/,
  );
  assert.equal(releaseWorkflow.match(/--ignore-scripts/g)?.length, 3);
  assert.doesNotMatch(releaseWorkflow, /npm run build|npm ci/);
  assert.doesNotMatch(manifestScript, /packageVersion/);
});
