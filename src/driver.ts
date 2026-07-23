import {
  assertNode24Version,
  createNode24BootstrapSource,
  loadNode24TypeDefinitionFiles,
} from "@torkbot/code-mode/node-runtime";
import type {
  RuntimeConnection,
  RuntimeDriver,
  RuntimeFinished,
} from "@torkbot/code-mode/runtime";
import type {
  SandboxInstance,
  SandboxProcess,
  SandboxProcessExit,
} from "@torkbot/sandbox";

const channelFileDescriptor = 3;
const maximumStderrLength = 64 * 1024;
const terminationGracePeriodMilliseconds = 1_000;

/** Required Sandbox resources and guest paths for a Node.js 24 Runtime. */
export interface SandboxNodeRuntimeOptions {
  /**
   * Caller-owned, booted Sandbox in which the runtime process will execute.
   *
   * The caller must keep this instance open until the Runtime is disposed.
   */
  readonly sandbox: SandboxInstance;
  /** Absolute path to the Node.js 24 executable inside the Sandbox guest. */
  readonly nodePath: string;
  /** Absolute guest directory used for native module resolution. */
  readonly cwd: string;
}

export const sandboxNodeRuntimeDriver:
  RuntimeDriver<SandboxNodeRuntimeOptions> = {
    description: "Sandbox-hosted Node.js 24",
    loadTypeDefinitionFiles: loadNode24TypeDefinitionFiles,
    async connect(options, request) {
      requireAbsoluteGuestPath("cwd", options.cwd);
      requireAbsoluteGuestPath("nodePath", options.nodePath);

      request.signal.throwIfAborted();
      const version = await readSandboxNodeVersion(options, request.signal);
      assertNode24Version(version, "Sandbox Node runtime");
      request.signal.throwIfAborted();

      return launchSandboxNode(
        options,
        createNode24BootstrapSource({
          runnerSource: request.runnerSource,
          channelFileDescriptor,
        }),
        request.signal,
      );
    },
  };

function requireAbsoluteGuestPath(name: string, value: string): void {
  if (!value.startsWith("/")) {
    throw new TypeError(`${name} must be an absolute guest path`);
  }
}

async function readSandboxNodeVersion(
  options: SandboxNodeRuntimeOptions,
  signal: AbortSignal,
): Promise<string> {
  const result = await options.sandbox.exec(
    options.nodePath,
    ["--version"],
    {
      cwd: options.cwd,
      signal,
    },
  );
  signal.throwIfAborted();

  if (result.exitCode !== 0) {
    throw new Error(formatVersionFailure(result.exitCode, result.stderr));
  }
  return result.stdout.trim();
}

async function launchSandboxNode(
  options: SandboxNodeRuntimeOptions,
  bootstrapSource: string,
  signal: AbortSignal,
): Promise<RuntimeConnection> {
  signal.throwIfAborted();
  const process = options.sandbox.spawn(
    options.nodePath,
    ["--input-type=module"],
    {
      cwd: options.cwd,
      pipes: [channelFileDescriptor],
    },
  );
  const pipe = process.pipes.get(channelFileDescriptor);
  if (pipe === undefined) {
    await stopPartialLaunch(process);
    throw new Error(
      `Sandbox Node.js runtime did not create fd ${channelFileDescriptor}`,
    );
  }

  const stdout = drain(process.stdout);
  const stderr = readTextTail(process.stderr);
  let terminationRequested = false;
  let finishedSettled = false;
  let forceTerminationTimeout: ReturnType<typeof setTimeout> | undefined;

  const requestTermination = (): void => {
    if (finishedSettled || terminationRequested) {
      return;
    }
    terminationRequested = true;
    process.kill("SIGTERM");
    forceTerminationTimeout ??= setTimeout(() => {
      process.kill("SIGKILL");
    }, terminationGracePeriodMilliseconds);
    forceTerminationTimeout.unref();
  };

  const finished: Promise<RuntimeFinished> = (async () => {
    try {
      const [launchError, exit, , stderrText] = await Promise.all([
        process.ready.then(
          () => null,
          (error: unknown) => errorFromUnknown(error),
        ),
        process.exit,
        stdout,
        stderr,
      ]);

      if (terminationRequested) {
        return { kind: "closed" };
      }
      if (launchError !== null) {
        return { kind: "failed", error: launchError };
      }
      if (exit.exitCode === 0 && exit.signal === null) {
        return { kind: "closed" };
      }
      return {
        kind: "failed",
        error: new Error(formatProcessFailure(exit, stderrText)),
      };
    } catch (error) {
      return {
        kind: "failed",
        error: errorFromUnknown(error),
      };
    } finally {
      finishedSettled = true;
      if (forceTerminationTimeout !== undefined) {
        clearTimeout(forceTerminationTimeout);
      }
    }
  })();

  const abort = (): void => requestTermination();
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }

  try {
    await process.ready;
    await writeAndClose(
      process.stdin,
      new TextEncoder().encode(bootstrapSource),
    );
    signal.throwIfAborted();
  } catch (error) {
    requestTermination();
    await finished;
    if (signal.aborted) {
      throw signal.reason;
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }

  return {
    channel: {
      readable: pipe.output,
      writable: pipe.input,
    },
    finished,
    async [Symbol.asyncDispose]() {
      requestTermination();
      await finished;
    },
  };
}

async function stopPartialLaunch(process: SandboxProcess): Promise<void> {
  process.kill("SIGTERM");
  const forceTerminationTimeout = setTimeout(() => {
    process.kill("SIGKILL");
  }, terminationGracePeriodMilliseconds);
  forceTerminationTimeout.unref();
  try {
    await Promise.allSettled([
      process.ready,
      process.exit,
      drain(process.stdout),
      drain(process.stderr),
    ]);
  } finally {
    clearTimeout(forceTerminationTimeout);
  }
}

async function writeAndClose(
  stream: WritableStream<Uint8Array>,
  contents: Uint8Array,
): Promise<void> {
  const writer = stream.getWriter();
  try {
    await writer.write(contents);
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const _chunk of stream) {
    // Drain ambient output so an unconsumed stream cannot block the runner.
  }
}

async function readTextTail(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text = appendTextTail(text, decoder.decode(chunk, { stream: true }));
  }
  return appendTextTail(text, decoder.decode());
}

function appendTextTail(current: string, chunk: string): string {
  if (chunk.length >= maximumStderrLength) {
    return chunk.slice(-maximumStderrLength);
  }
  const overflow = current.length + chunk.length - maximumStderrLength;
  return overflow > 0
    ? `${current.slice(overflow)}${chunk}`
    : `${current}${chunk}`;
}

function formatVersionFailure(exitCode: number, stderr: string): string {
  const status = `Sandbox Node.js version check failed with exit code ${exitCode}`;
  const detail = stderr.trim();
  return detail.length === 0 ? status : `${status}: ${detail}`;
}

function formatProcessFailure(
  exit: SandboxProcessExit,
  stderr: string,
): string {
  const status = [
    "Sandbox Node.js runtime failed with",
    `exit code ${exit.exitCode}, signal ${exit.signal}`,
  ].join(" ");
  const detail = stderr.trim();
  return detail.length === 0 ? status : `${status}: ${detail}`;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
