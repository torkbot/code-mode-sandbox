import type {
  Node24RuntimeHost,
  Node24RuntimeLaunchRequest,
} from "@torkbot/code-mode/node";
import type {
  ByteChannel,
  ByteWriter,
  RuntimeFinished,
  RuntimeInstance,
} from "@torkbot/code-mode/runtime";
import type {
  SandboxInstance,
  SandboxProcess,
  SandboxProcessExit,
} from "@torkbot/sandbox";

const maximumStderrLength = 64 * 1024;
const terminationGracePeriodMilliseconds = 1_000;

export interface SandboxNodeRuntimeHostOptions {
  readonly sandbox: SandboxInstance;
  readonly nodePath: string;
  readonly cwd: string;
}

/**
 * Creates the Sandbox execution host required by Node24Runtime.
 *
 * The caller must keep the Sandbox instance open while the runtime is in use
 * and remains responsible for closing it. The host owns only the guest
 * processes it launches through Node24Runtime.
 */
export function createSandboxNodeRuntimeHost(
  options: SandboxNodeRuntimeHostOptions,
): Node24RuntimeHost {
  return {
    readNodeVersion: (signal) => readSandboxNodeVersion(options, signal),
    launchNode: (req) => launchSandboxNode(options, req),
  };
}

async function readSandboxNodeVersion(
  options: SandboxNodeRuntimeHostOptions,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
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
  options: SandboxNodeRuntimeHostOptions,
  req: Node24RuntimeLaunchRequest,
): Promise<RuntimeInstance> {
  req.signal.throwIfAborted();
  const process = options.sandbox.spawn(
    options.nodePath,
    ["--input-type=module"],
    {
      cwd: options.cwd,
      pipes: [req.channelFileDescriptor],
    },
  );
  const pipe = process.pipes.get(req.channelFileDescriptor);
  if (pipe === undefined) {
    await stopPartialLaunch(process);
    throw new Error(
      `Sandbox Node.js runtime did not create fd ${req.channelFileDescriptor}`,
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
  const abort = (): void => requestTermination();

  if (req.signal.aborted) {
    abort();
  } else {
    req.signal.addEventListener("abort", abort, { once: true });
  }

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
      req.signal.removeEventListener("abort", abort);
      if (forceTerminationTimeout !== undefined) {
        clearTimeout(forceTerminationTimeout);
      }
    }
  })();

  try {
    await process.ready;
    await writeAndClose(
      process.stdin,
      new TextEncoder().encode(req.bootstrapSource),
    );
  } catch (error) {
    requestTermination();
    await finished;
    if (req.signal.aborted) {
      throw req.signal.reason;
    }
    throw error;
  }

  if (req.signal.aborted) {
    requestTermination();
    await finished;
    throw req.signal.reason;
  }

  const channel: ByteChannel = {
    incoming: readableChunks(pipe.output),
    outgoing: new WebByteWriter(pipe.input),
  };

  return {
    channel,
    finished,
    async terminate(_reason: string): Promise<void> {
      requestTermination();
      await finished;
    },
  };
}

class WebByteWriter implements ByteWriter {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  #closing: Promise<void> | undefined;

  constructor(stream: WritableStream<Uint8Array>) {
    this.#writer = stream.getWriter();
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#closing !== undefined) {
      throw new Error("Sandbox Node.js runtime byte channel is closed");
    }
    await this.#writer.write(chunk);
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    try {
      await this.#writer.close();
    } finally {
      this.#writer.releaseLock();
    }
  }
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

async function* readableChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const _chunk of readableChunks(stream)) {
    // Drain output so an unconsumed stream cannot block process completion.
  }
}

async function readTextTail(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of readableChunks(stream)) {
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
