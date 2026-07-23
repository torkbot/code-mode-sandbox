import assert from "node:assert/strict";
import {
  execFile,
  spawn as spawnChildProcess,
} from "node:child_process";
import {
  Duplex,
  Readable,
  Writable,
} from "node:stream";
import test from "node:test";

import {
  createClient,
  createToolbox,
} from "@torkbot/code-mode";
import type { Runtime } from "@torkbot/code-mode";
import { testRuntime } from "@torkbot/code-mode/testing";
import type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxInstance,
  SandboxProcess,
  SandboxProcessExit,
  SandboxProcessPipe,
  SandboxSignal,
  SandboxSpawnOptions,
} from "@torkbot/sandbox";

import { sandboxNodeRuntimeDriver } from "./driver.ts";
import { createSandboxNodeRuntime } from "./index.ts";

const runtimeOptions = {
  nodePath: process.execPath,
  cwd: process.cwd(),
};

testRuntime({
  name: "Sandbox Node runtime",
  createRuntime(signal) {
    return createSandboxNodeRuntime({
      ...runtimeOptions,
      sandbox: createHostBackedSandbox().instance,
    }, signal);
  },
});

test("Sandbox Node runtime supplies Node declarations and resolves native static imports from cwd", async () => {
  const sandbox = createHostBackedSandbox();
  const runtime = await createRuntime(sandbox.instance);

  try {
    const typeDefinitions = await runtime.loadTypeDefinitionFiles(
      AbortSignal.timeout(5_000),
    );
    assertTypeDefinitionExists(
      typeDefinitions,
      "node_modules/@types/node/index.d.ts",
    );
    assertTypeDefinitionExists(
      typeDefinitions,
      "node_modules/undici-types/index.d.ts",
    );

    const client = createClient({
      runtime,
      toolbox: createToolbox([]),
    });
    assert.deepEqual(await client.validate([
      'import { basename } from "node:path";',
      "",
      "export default function ({ console }: AgentProgramScope) {",
      '  console.log(basename("/workspace/value.txt"));',
      "}",
    ].join("\n"), AbortSignal.timeout(5_000)), { kind: "valid" });

    let output = "";
    assert.deepEqual(await runtime.execute({
      source: [
        'import { createToolbox } from "@torkbot/code-mode";',
        "",
        "export default function ({ console }) {",
        '  console.log(typeof createToolbox);',
        "}",
      ].join("\n"),
      signal: AbortSignal.timeout(5_000),
      async invokeTool() {
        throw new Error("program must not invoke tools");
      },
      emitOutput(chunk) {
        output += chunk.text;
      },
    }), { kind: "success" });
    assert.match(output, /function/);
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("Sandbox Node runtime boots one persistent fd 3 runner and detaches its boot signal", async () => {
  const sandbox = createHostBackedSandbox();
  const boot = new AbortController();
  const runtime = await createSandboxNodeRuntime({
    ...runtimeOptions,
    sandbox: sandbox.instance,
  }, boot.signal);

  try {
    assert.deepEqual(sandbox.execCalls(), [{
      command: process.execPath,
      args: ["--version"],
      options: {
        cwd: process.cwd(),
        signal: boot.signal,
      },
    }]);
    assert.deepEqual(sandbox.spawnCalls(), [{
      command: process.execPath,
      args: ["--input-type=module"],
      options: {
        cwd: process.cwd(),
        pipes: [3],
      },
    }]);
    assert.equal(sandbox.processCount(), 1);
    assert.match(
      new TextDecoder().decode(joinBytes(sandbox.stdinWrites())),
      /^export async function startRunner/,
    );
    assert.match(
      new TextDecoder().decode(joinBytes(sandbox.stdinWrites())),
      /registerHooks/,
    );

    boot.abort(new Error("boot ownership ended"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sandbox.killSignals(), []);

    assert.deepEqual(await runtime.execute({
      source: "export default function () {}",
      signal: AbortSignal.timeout(5_000),
      async invokeTool() {
        throw new Error("program must not invoke tools");
      },
      emitOutput() {},
    }), { kind: "success" });
    assert.deepEqual(sandbox.killSignals(), []);
  } finally {
    await runtime[Symbol.asyncDispose]();
  }

  assert.deepEqual(sandbox.killSignals(), ["SIGTERM"]);
  assert.equal(sandbox.closeCalls(), 0);
  assert.deepEqual(await runtime.finished, { kind: "closed" });
});

test("Sandbox Node runtime multiplexes executions on its persistent runner", async () => {
  const sandbox = createHostBackedSandbox();
  const runtime = await createRuntime(sandbox.instance);

  try {
    const started: string[] = [];
    const bothStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const execute = (label: string) => runtime.execute({
      source: [
        "export default async function ({ codemode }) {",
        `  await codemode.wait({ label: ${JSON.stringify(label)} });`,
        "}",
      ].join("\n"),
      signal: AbortSignal.timeout(5_000),
      async invokeTool(request) {
        const input = request.input as { readonly label: string };
        started.push(input.label);
        if (started.length === 2) bothStarted.resolve();
        await release.promise;
        return {};
      },
      emitOutput() {},
    });

    const first = execute("first");
    const second = execute("second");
    await bothStarted.promise;
    assert.deepEqual(new Set(started), new Set(["first", "second"]));
    assert.equal(sandbox.processCount(), 1);

    release.resolve();
    assert.deepEqual(await Promise.all([first, second]), [
      { kind: "success" },
      { kind: "success" },
    ]);
  } finally {
    await runtime[Symbol.asyncDispose]();
  }
});

test("Sandbox Node runtime becomes failed after an unexpected runner exit", async () => {
  const sandbox = createHostBackedSandbox();
  const runtime = await createRuntime(sandbox.instance);

  const execution = runtime.execute({
    source: [
      "export default async function () {",
      "  await new Promise((resolve, reject) => {",
      '    process.stderr.write("guest exploded", (error) => {',
      "      if (error) reject(error);",
      "      else resolve();",
      "    });",
      "  });",
      "  process.exit(23);",
      "}",
    ].join("\n"),
    signal: AbortSignal.timeout(5_000),
    async invokeTool() {
      throw new Error("program must not invoke tools");
    },
    emitOutput() {},
  });

  await assert.rejects(execution);
  const finished = await runtime.finished;
  assert.equal(finished.kind, "failed");
  await runtime[Symbol.asyncDispose]();
});

test("Sandbox Node driver reports unexpected process failures with ambient stderr", async () => {
  const process = createFakeSandboxProcess({ stderr: "guest exploded" });
  const sandbox = createObservedSandbox(process.instance);
  const connection = await sandboxNodeRuntimeDriver.connect(
    {
      sandbox: sandbox.instance,
      nodePath: "/usr/bin/node",
      cwd: "/workspace",
    },
    {
      runnerSource: "export async function startRunner() {}",
      signal: AbortSignal.timeout(5_000),
    },
  );

  process.resolveExit({ exitCode: 23, signal: null });
  const finished = await connection.finished;
  assert.equal(finished.kind, "failed");
  if (finished.kind === "failed") {
    assert.match(finished.error.message, /exit code 23/);
    assert.match(finished.error.message, /guest exploded/);
  }
  await connection[Symbol.asyncDispose]();
});

test("Sandbox Node runtime rejects invalid guest paths before touching Sandbox", async () => {
  const sandbox = createObservedSandbox(createFakeSandboxProcess().instance);

  await assert.rejects(createSandboxNodeRuntime({
    sandbox: sandbox.instance,
    nodePath: "/usr/bin/node",
    cwd: "workspace",
  }, AbortSignal.timeout(5_000)), /cwd must be an absolute guest path/);
  await assert.rejects(createSandboxNodeRuntime({
    sandbox: sandbox.instance,
    nodePath: "node",
    cwd: "/workspace",
  }, AbortSignal.timeout(5_000)), /nodePath must be an absolute guest path/);

  assert.deepEqual(sandbox.execCalls(), []);
  assert.deepEqual(sandbox.spawnCalls(), []);
});

test("Sandbox Node runtime rejects a non-Node-24 guest before spawning", async () => {
  const sandbox = createObservedSandbox(createFakeSandboxProcess().instance, {
    exitCode: 0,
    stdout: "v23.11.0\n",
    stderr: "",
  });

  await assert.rejects(
    createSandboxNodeRuntime({
      sandbox: sandbox.instance,
      nodePath: "/usr/bin/node",
      cwd: "/workspace",
    }, AbortSignal.timeout(5_000)),
    /requires Node\.js 24/,
  );
  assert.deepEqual(sandbox.spawnCalls(), []);
});

test("Sandbox Node runtime cleans up when Sandbox omits fd 3", async () => {
  const process = createFakeSandboxProcess({ includeChannel: false });
  const sandbox = createObservedSandbox(process.instance);

  await assert.rejects(
    createSandboxNodeRuntime({
      sandbox: sandbox.instance,
      nodePath: "/usr/bin/node",
      cwd: "/workspace",
    }, AbortSignal.timeout(5_000)),
    /did not create fd 3/,
  );
  assert.deepEqual(process.kills(), ["SIGTERM"]);
});

test("Sandbox Node runtime cleans up a failed Sandbox process launch", async () => {
  const process = createFakeSandboxProcess({
    readyError: new Error("guest launch failed"),
  });
  const sandbox = createObservedSandbox(process.instance);

  await assert.rejects(
    createSandboxNodeRuntime({
      sandbox: sandbox.instance,
      nodePath: "/usr/bin/node",
      cwd: "/workspace",
    }, AbortSignal.timeout(5_000)),
    /guest launch failed/,
  );
  assert.deepEqual(process.kills(), ["SIGTERM"]);
});

test("Sandbox Node runtime boot cancellation stops only the partial runner", async () => {
  const process = createFakeSandboxProcess({ readyPending: true });
  const sandbox = createObservedSandbox(process.instance);
  const boot = new AbortController();
  const reason = new Error("cancel boot");
  const runtime = createSandboxNodeRuntime({
    sandbox: sandbox.instance,
    nodePath: "/usr/bin/node",
    cwd: "/workspace",
  }, boot.signal);

  await waitFor(() => sandbox.spawnCalls().length === 1);
  boot.abort(reason);

  await assert.rejects(runtime, (error) => error === reason);
  assert.deepEqual(process.kills(), ["SIGTERM"]);
  assert.equal(sandbox.closeCalls(), 0);
});

function createRuntime(sandbox: SandboxInstance): Promise<Runtime> {
  return createSandboxNodeRuntime({
    ...runtimeOptions,
    sandbox,
  }, AbortSignal.timeout(5_000));
}

type ObservedExec = {
  readonly command: string;
  readonly args: readonly string[] | undefined;
  readonly options: SandboxExecOptions | undefined;
};

type ObservedSpawn = {
  readonly command: string;
  readonly args: readonly string[] | undefined;
  readonly options: SandboxSpawnOptions | undefined;
};

function createHostBackedSandbox(): {
  readonly instance: SandboxInstance;
  execCalls(): readonly ObservedExec[];
  spawnCalls(): readonly ObservedSpawn[];
  stdinWrites(): readonly Uint8Array[];
  killSignals(): readonly SandboxSignal[];
  processCount(): number;
  closeCalls(): number;
} {
  const execCalls: ObservedExec[] = [];
  const spawnCalls: ObservedSpawn[] = [];
  const stdinWrites: Uint8Array[] = [];
  const killSignals: SandboxSignal[] = [];
  let processCount = 0;
  let closeCalls = 0;
  const unsupported = (): never => {
    throw new Error("not used by this runtime test");
  };

  return {
    instance: {
      fs: {
        stat: unsupported,
        readDir: unsupported,
        readFile: unsupported,
        writeFile: unsupported,
        mkdir: unsupported,
        remove: unsupported,
        rename: unsupported,
      },
      async environmentFacts() {
        return [];
      },
      async exec(command, args, options) {
        execCalls.push({ command, args, options });
        return await execHost(command, args, options);
      },
      spawn(command, args, options) {
        spawnCalls.push({ command, args, options });
        processCount += 1;
        return spawnHostProcess(
          command,
          args,
          options,
          stdinWrites,
          killSignals,
        );
      },
      pty: unsupported,
      async close() {
        closeCalls += 1;
      },
      async [Symbol.asyncDispose]() {
        closeCalls += 1;
      },
    },
    execCalls: () => execCalls,
    spawnCalls: () => spawnCalls,
    stdinWrites: () => stdinWrites,
    killSignals: () => killSignals,
    processCount: () => processCount,
    closeCalls: () => closeCalls,
  };
}

function execHost(
  command: string,
  args: readonly string[] | undefined,
  options: SandboxExecOptions | undefined,
): Promise<SandboxExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...(args ?? [])],
      {
        cwd: options?.cwd,
        env: options?.env === undefined
          ? process.env
          : { ...process.env, ...options.env },
        signal: options?.signal,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (options?.signal?.aborted === true) {
          reject(options.signal.reason);
          return;
        }
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({
          exitCode: 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function spawnHostProcess(
  command: string,
  args: readonly string[] | undefined,
  options: SandboxSpawnOptions | undefined,
  stdinWrites: Uint8Array[],
  killSignals: SandboxSignal[],
): SandboxProcess {
  const pipes = options?.pipes ?? [];
  const maximumFileDescriptor = Math.max(2, ...pipes);
  const stdio = Array.from(
    { length: maximumFileDescriptor + 1 },
    (_, fileDescriptor): "ignore" | "pipe" => (
      fileDescriptor <= 2 || pipes.includes(fileDescriptor) ? "pipe" : "ignore"
    ),
  );
  const child = spawnChildProcess(command, [...(args ?? [])], {
    cwd: options?.cwd,
    env: options?.env === undefined
      ? process.env
      : { ...process.env, ...options.env },
    stdio,
  });

  assert.ok(child.stdin !== null);
  assert.ok(child.stdout !== null);
  assert.ok(child.stderr !== null);

  const ready = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exit = new Promise<SandboxProcessExit>((resolve) => {
    child.once("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal: signal as SandboxSignal | null,
      });
    });
  });
  const processPipes = new Map<number, SandboxProcessPipe>();
  for (const fileDescriptor of pipes) {
    const stream = child.stdio[fileDescriptor];
    assert.ok(stream instanceof Duplex);
    const channel = Duplex.toWeb(stream);
    processPipes.set(fileDescriptor, {
      input: channel.writable,
      output: channel.readable,
    });
  }

  return {
    stdin: recordWrites(Writable.toWeb(child.stdin), stdinWrites),
    stdout: Readable.toWeb(child.stdout),
    stderr: Readable.toWeb(child.stderr),
    pipes: processPipes,
    ready,
    exit,
    kill(signal = "SIGTERM") {
      killSignals.push(signal);
      child.kill(signal);
    },
  };
}

function recordWrites(
  destination: WritableStream<Uint8Array>,
  writes: Uint8Array[],
): WritableStream<Uint8Array> {
  const writer = destination.getWriter();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    writer.releaseLock();
  };

  return new WritableStream({
    async write(chunk) {
      writes.push(chunk.slice());
      await writer.write(chunk);
    },
    async close() {
      try {
        await writer.close();
      } finally {
        release();
      }
    },
    async abort(reason) {
      try {
        await writer.abort(reason);
      } finally {
        release();
      }
    },
  });
}

function createObservedSandbox(
  process: SandboxProcess,
  versionResult: SandboxExecResult = {
    exitCode: 0,
    stdout: "v24.12.0\n",
    stderr: "",
  },
): {
  readonly instance: SandboxInstance;
  execCalls(): readonly ObservedExec[];
  spawnCalls(): readonly ObservedSpawn[];
  closeCalls(): number;
} {
  const execCalls: ObservedExec[] = [];
  const spawnCalls: ObservedSpawn[] = [];
  let closeCalls = 0;
  const unsupported = (): never => {
    throw new Error("not used by this runtime lifecycle test");
  };

  return {
    instance: {
      fs: {
        stat: unsupported,
        readDir: unsupported,
        readFile: unsupported,
        writeFile: unsupported,
        mkdir: unsupported,
        remove: unsupported,
        rename: unsupported,
      },
      async environmentFacts() {
        return [];
      },
      async exec(command, args, options) {
        execCalls.push({ command, args, options });
        return versionResult;
      },
      spawn(command, args, options) {
        spawnCalls.push({ command, args, options });
        return process;
      },
      pty: unsupported,
      async close() {
        closeCalls += 1;
      },
      async [Symbol.asyncDispose]() {
        closeCalls += 1;
      },
    },
    execCalls: () => execCalls,
    spawnCalls: () => spawnCalls,
    closeCalls: () => closeCalls,
  };
}

function createFakeSandboxProcess(options: {
  readonly includeChannel?: boolean;
  readonly readyError?: Error;
  readonly readyPending?: boolean;
  readonly stderr?: string;
} = {}): {
  readonly instance: SandboxProcess;
  kills(): readonly SandboxSignal[];
  resolveExit(exit: SandboxProcessExit): void;
} {
  const stdin = createWritableRecorder();
  const channelInput = createWritableRecorder();
  const ready = Promise.withResolvers<void>();
  const exit = Promise.withResolvers<SandboxProcessExit>();
  const kills: SandboxSignal[] = [];
  const includeChannel = options.includeChannel ?? true;

  if (options.readyError !== undefined) {
    ready.reject(options.readyError);
  } else if (options.readyPending !== true) {
    ready.resolve();
  }

  return {
    instance: {
      stdin: stdin.stream,
      stdout: readableFrom([]),
      stderr: readableFrom([
        new TextEncoder().encode(options.stderr ?? ""),
      ]),
      pipes: includeChannel
        ? new Map([[3, {
            input: channelInput.stream,
            output: readableFrom([]),
          }]])
        : new Map(),
      ready: ready.promise,
      exit: exit.promise,
      kill(signal = "SIGTERM") {
        kills.push(signal);
        ready.reject(new Error("Sandbox process stopped before readiness"));
        exit.resolve({ exitCode: null, signal });
      },
    },
    kills: () => kills,
    resolveExit: exit.resolve,
  };
}

function createWritableRecorder(): {
  readonly stream: WritableStream<Uint8Array>;
} {
  return {
    stream: new WritableStream(),
  };
}

function readableFrom(
  chunks: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

function assertTypeDefinitionExists(
  files: readonly { readonly path: string }[],
  path: string,
): void {
  assert.ok(
    files.some((file) => file.path === path),
    `missing ${path}`,
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for test observation");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}
