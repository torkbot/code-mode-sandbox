import assert from "node:assert/strict";
import test from "node:test";

import type {
  SandboxBootOptions,
  SandboxDefinition,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxInstance,
  SandboxProcess,
  SandboxProcessExit,
  SandboxSignal,
  SandboxSpawnOptions,
} from "@torkbot/sandbox";

import {
  openSandboxCodeMode,
  SandboxNodeRuntime,
} from "./index.ts";

test("openSandboxCodeMode boots the supplied definition and owns its lifecycle", async () => {
  const sandbox = createLifecycleSandbox();
  let observedBoot: SandboxBootOptions | undefined;
  const definition: SandboxDefinition = {
    environmentFacts: () => [],
    async boot(options) {
      observedBoot = options;
      return sandbox.instance;
    },
  };

  const session = await openSandboxCodeMode({
    definition,
    boot: {
      cwd: "/workspace",
      hostname: "code-mode-test",
    },
    nodePath: "/usr/bin/node",
  });

  assert.deepEqual(observedBoot, {
    cwd: "/workspace",
    hostname: "code-mode-test",
  });
  assert.equal(session.sandbox, sandbox.instance);
  assert.ok(session.runtime instanceof SandboxNodeRuntime);

  await Promise.all([
    session.close(),
    session.close(),
    session[Symbol.asyncDispose](),
  ]);
  assert.equal(sandbox.closeCalls(), 1);
});

test("SandboxNodeRuntime launches the code-mode bootstrap over Sandbox process pipes", async () => {
  const process = createSandboxProcess({
    channelOutput: [new TextEncoder().encode("runtime output")],
  });
  const sandbox = createRuntimeSandbox(process.instance);
  const runtime = new SandboxNodeRuntime({
    sandbox: sandbox.instance,
    nodePath: "/usr/bin/node",
    cwd: "/workspace",
  });
  const signal = AbortSignal.timeout(5_000);

  const instance = await runtime.start({
    payload: {
      kind: "javascript-module",
      source: "export async function startProgram() { /* payload sentinel */ }",
    },
    signal,
  });

  assert.deepEqual(sandbox.execCalls(), [{
    command: "/usr/bin/node",
    args: ["--version"],
    options: {
      cwd: "/workspace",
      signal,
    },
  }]);
  assert.deepEqual(sandbox.spawnCalls(), [{
    command: "/usr/bin/node",
    args: ["--input-type=module"],
    options: {
      cwd: "/workspace",
      pipes: [3],
    },
  }]);
  assert.equal(process.stdinClosed(), true);
  assert.match(
    new TextDecoder().decode(joinBytes(process.stdinWrites())),
    /payload sentinel/,
  );
  assert.deepEqual(
    (await collect(instance.channel.incoming)).map((chunk) => (
      new TextDecoder().decode(chunk)
    )),
    ["runtime output"],
  );

  await instance.channel.outgoing.write(new TextEncoder().encode("host input"));
  await Promise.all([
    instance.channel.outgoing.close(),
    instance.channel.outgoing.close(),
  ]);
  assert.equal(process.channelInputClosed(), true);
  assert.equal(
    new TextDecoder().decode(joinBytes(process.channelInputWrites())),
    "host input",
  );

  await Promise.all([
    instance.terminate("test complete"),
    instance.terminate("test complete again"),
  ]);
  assert.deepEqual(process.kills(), ["SIGTERM"]);
  assert.deepEqual(await instance.finished, { kind: "closed" });
});

test("SandboxNodeRuntime rejects launch when Sandbox omits the requested pipe", async () => {
  const process = createSandboxProcess({
    includeChannel: false,
    readyError: new Error("guest launch failed without fd 3"),
  });
  const sandbox = createRuntimeSandbox(process.instance);
  const runtime = new SandboxNodeRuntime({
    sandbox: sandbox.instance,
    nodePath: "/usr/bin/node",
    cwd: "/workspace",
  });

  await assert.rejects(runtime.start({
    payload: {
      kind: "javascript-module",
      source: "export async function startProgram() {}",
    },
    signal: AbortSignal.timeout(5_000),
  }), /did not create fd 3/);
  assert.deepEqual(process.kills(), ["SIGTERM"]);
});

test("SandboxNodeRuntime rejects a non-Node-24 guest before spawning", async () => {
  const process = createSandboxProcess();
  const sandbox = createRuntimeSandbox(process.instance, {
    exitCode: 0,
    stdout: "v23.11.0\n",
    stderr: "",
  });
  const runtime = new SandboxNodeRuntime({
    sandbox: sandbox.instance,
    nodePath: "/usr/bin/node",
    cwd: "/workspace",
  });

  await assert.rejects(runtime.start({
    payload: {
      kind: "javascript-module",
      source: "export async function startProgram() {}",
    },
    signal: AbortSignal.timeout(5_000),
  }), /requires Node\.js 24/);
  assert.deepEqual(sandbox.spawnCalls(), []);
});

test("SandboxNodeRuntime cleans up and rejects Sandbox launch failures", async () => {
  const process = createSandboxProcess({
    readyError: new Error("guest launch failed"),
  });
  const sandbox = createRuntimeSandbox(process.instance);
  const runtime = new SandboxNodeRuntime({
    sandbox: sandbox.instance,
    nodePath: "/usr/bin/node",
    cwd: "/workspace",
  });

  await assert.rejects(runtime.start({
    payload: {
      kind: "javascript-module",
      source: "export async function startProgram() {}",
    },
    signal: AbortSignal.timeout(5_000),
  }), /guest launch failed/);
  assert.deepEqual(process.kills(), ["SIGTERM"]);
});

test("SandboxNodeRuntime reports unexpected guest process failures with stderr", async () => {
  const process = createSandboxProcess({ stderr: "guest exploded" });
  const sandbox = createRuntimeSandbox(process.instance);
  const runtime = new SandboxNodeRuntime({
    sandbox: sandbox.instance,
    nodePath: "/usr/bin/node",
    cwd: "/workspace",
  });
  const instance = await runtime.start({
    payload: {
      kind: "javascript-module",
      source: "export async function startProgram() {}",
    },
    signal: AbortSignal.timeout(5_000),
  });

  process.resolveExit({ exitCode: 1, signal: null });
  const finished = await instance.finished;
  assert.equal(finished.kind, "failed");
  if (finished.kind === "failed") {
    assert.match(finished.error.message, /exit code 1/);
    assert.match(finished.error.message, /guest exploded/);
  }
});

test("SandboxNodeRuntime aborts a launched process and resolves it as closed", async () => {
  const process = createSandboxProcess();
  const sandbox = createRuntimeSandbox(process.instance);
  const runtime = new SandboxNodeRuntime({
    sandbox: sandbox.instance,
    nodePath: "/usr/bin/node",
    cwd: "/workspace",
  });
  const controller = new AbortController();
  const instance = await runtime.start({
    payload: {
      kind: "javascript-module",
      source: "export async function startProgram() {}",
    },
    signal: controller.signal,
  });

  controller.abort(new Error("cancel runtime"));

  assert.deepEqual(await instance.finished, { kind: "closed" });
  assert.deepEqual(process.kills(), ["SIGTERM"]);
});

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

function createRuntimeSandbox(
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
} {
  const execCalls: ObservedExec[] = [];
  const spawnCalls: ObservedSpawn[] = [];
  const unsupported = (): never => {
    throw new Error("not used by this runtime host test");
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
      async exec(command, args, options): Promise<SandboxExecResult> {
        execCalls.push({ command, args, options });
        return versionResult;
      },
      spawn(command, args, options) {
        spawnCalls.push({ command, args, options });
        return process;
      },
      pty: unsupported,
      async close() {},
      async [Symbol.asyncDispose]() {},
    },
    execCalls: () => execCalls,
    spawnCalls: () => spawnCalls,
  };
}

function createLifecycleSandbox(): {
  readonly instance: SandboxInstance;
  closeCalls(): number;
} {
  let closeCalls = 0;
  const unsupported = (): never => {
    throw new Error("not used by this lifecycle test");
  };
  const close = async (): Promise<void> => {
    closeCalls += 1;
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
      environmentFacts: unsupported,
      exec: unsupported,
      spawn: unsupported,
      pty: unsupported,
      close,
      [Symbol.asyncDispose]: close,
    },
    closeCalls: () => closeCalls,
  };
}

function createSandboxProcess(options: {
  readonly channelOutput?: readonly Uint8Array[];
  readonly includeChannel?: boolean;
  readonly readyError?: Error;
  readonly stderr?: string;
} = {}): {
  readonly instance: SandboxProcess;
  channelInputClosed(): boolean;
  channelInputWrites(): readonly Uint8Array[];
  stdinClosed(): boolean;
  stdinWrites(): readonly Uint8Array[];
  kills(): readonly SandboxSignal[];
  resolveExit(exit: SandboxProcessExit): void;
} {
  const stdin = createWritableRecorder();
  const channelInput = createWritableRecorder();
  const exit = deferred<SandboxProcessExit>();
  const kills: SandboxSignal[] = [];
  const includeChannel = options.includeChannel ?? true;

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
            output: readableFrom(options.channelOutput ?? []),
          }]])
        : new Map(),
      ready: options.readyError === undefined
        ? Promise.resolve()
        : Promise.reject(options.readyError),
      exit: exit.promise,
      kill(signal = "SIGTERM") {
        kills.push(signal);
        exit.resolve({ exitCode: null, signal });
      },
    },
    channelInputClosed: channelInput.closed,
    channelInputWrites: channelInput.writes,
    stdinClosed: stdin.closed,
    stdinWrites: stdin.writes,
    kills: () => kills,
    resolveExit: exit.resolve,
  };
}

function createWritableRecorder(): {
  readonly stream: WritableStream<Uint8Array>;
  closed(): boolean;
  writes(): readonly Uint8Array[];
} {
  const writes: Uint8Array[] = [];
  let closed = false;
  return {
    stream: new WritableStream({
      write(chunk) {
        writes.push(chunk.slice());
      },
      close() {
        closed = true;
      },
    }),
    closed: () => closed,
    writes: () => writes,
  };
}

function readableFrom(
  chunks: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      assert.ok(resolvePromise !== undefined);
      resolvePromise(value);
    },
  };
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

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}
