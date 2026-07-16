import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

type ReleaseArtifactManifest = {
  readonly schemaVersion: 2;
  readonly headSha: string;
  readonly packageName: string;
  readonly tarball: {
    readonly file: string;
    readonly sha256: string;
  };
};

const repoRoot = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const command = args[0];

if (command === "write") {
  const tarball = resolve(repoRoot, requiredArg("--tarball"));
  const manifest: ReleaseArtifactManifest = {
    schemaVersion: 2,
    headSha: requiredArg("--head-sha"),
    packageName: requiredArg("--package-name"),
    tarball: {
      file: basename(tarball),
      sha256: await sha256File(tarball),
    },
  };
  await writeFile(resolve(repoRoot, requiredArg("--output")), `${JSON.stringify(manifest, null, 2)}\n`);
} else if (command === "verify") {
  const manifestPath = resolve(repoRoot, requiredArg("--manifest"));
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  assertEqual("schema version", manifest.schemaVersion, 2);
  assertEqual("head SHA", manifest.headSha, requiredArg("--head-sha"));
  assertEqual("package name", manifest.packageName, requiredArg("--package-name"));
  assertEqual(
    "tarball digest",
    await sha256File(resolve(dirname(manifestPath), manifest.tarball.file)),
    manifest.tarball.sha256,
  );
} else {
  throw new Error("usage: release-artifact-manifest.ts <write|verify> ...");
}

function requiredArg(name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`missing required argument: ${name}`);
  }
  return value;
}

function assertEqual(label: string, actual: string | number, expected: string | number): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function parseManifest(value: unknown): ReleaseArtifactManifest {
  if (
    typeof value !== "object" || value === null ||
    !("schemaVersion" in value) || value.schemaVersion !== 2 ||
    !("headSha" in value) || typeof value.headSha !== "string" ||
    !("packageName" in value) || typeof value.packageName !== "string" ||
    !("tarball" in value) || typeof value.tarball !== "object" || value.tarball === null ||
    !("file" in value.tarball) || typeof value.tarball.file !== "string" ||
    basename(value.tarball.file) !== value.tarball.file ||
    !("sha256" in value.tarball) || typeof value.tarball.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.tarball.sha256)
  ) {
    throw new Error("invalid release artifact manifest");
  }
  return value as ReleaseArtifactManifest;
}
