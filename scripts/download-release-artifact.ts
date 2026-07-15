import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

type WorkflowRun = {
  readonly conclusion: string | null;
  readonly databaseId: number;
  readonly headBranch: string;
  readonly headSha: string;
  readonly status: string;
  readonly url: string;
};

const repoRoot = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const targetSha = requiredArg("--target-sha");
const runs = parseWorkflowRuns(JSON.parse(await execute("gh", [
  "run",
  "list",
  "--workflow",
  "CI",
  "--branch",
  "main",
  "--commit",
  targetSha,
  "--event",
  "push",
  "--limit",
  "5",
  "--json",
  "databaseId,headBranch,headSha,conclusion,status,url",
])));
const run = runs.find((candidate) =>
  candidate.headBranch === "main" &&
  candidate.headSha === targetSha &&
  candidate.status === "completed"
);

if (run === undefined) {
  throw new Error(`no completed main CI run found for ${targetSha}`);
}
if (run.conclusion !== "success") {
  throw new Error(`main CI run did not succeed for ${targetSha}: ${run.url}`);
}

const outDir = resolve(repoRoot, "dist/release-artifact");
await mkdir(outDir, { recursive: true });
await execute("gh", [
  "run",
  "download",
  String(run.databaseId),
  "--name",
  "release-package",
  "--dir",
  outDir,
]);

function requiredArg(name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`missing required argument: ${name}`);
  }
  return value;
}

async function execute(command: string, commandArgs: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString("utf8"));
      } else {
        reject(new Error(`${command} ${commandArgs.join(" ")} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      }
    });
  });
}

function parseWorkflowRuns(value: unknown): WorkflowRun[] {
  if (!Array.isArray(value)) {
    throw new Error("expected GitHub workflow runs to be an array");
  }
  return value.map((run, index) => {
    if (
      typeof run !== "object" || run === null ||
      !("conclusion" in run) || (run.conclusion !== null && typeof run.conclusion !== "string") ||
      !("databaseId" in run) || typeof run.databaseId !== "number" ||
      !("headBranch" in run) || typeof run.headBranch !== "string" ||
      !("headSha" in run) || typeof run.headSha !== "string" ||
      !("status" in run) || typeof run.status !== "string" ||
      !("url" in run) || typeof run.url !== "string"
    ) {
      throw new Error(`invalid GitHub workflow run at index ${index}`);
    }
    return run as WorkflowRun;
  });
}
