# @torkbot/code-mode-sandbox

Run [`@torkbot/code-mode`](https://github.com/torkbot/code-mode) programs with
Node.js 24 inside
[`@torkbot/sandbox`](https://github.com/torkbot/sandbox) microVMs.

This package owns the integration between code mode's runtime-driver contract
and Sandbox process execution. It boots one persistent, connected code-mode
runner inside a caller-owned `SandboxInstance` and exposes it as a standard
`Runtime`.

The caller owns the Sandbox lifecycle. It chooses the image, persistence,
mounts, resources, network access, machine identity, and reuse policy; boots
the machine; keeps it open while the runtime is in use; and closes it afterward.
The runtime owns only its guest Node.js process.

`@torkbot/code-mode` owns source checking, TypeScript erasure, tool routing,
output routing, execution correlation, its wire protocol, and the reusable
Node.js 24 runner semantics. `@torkbot/sandbox` owns isolated VM execution. This
package supplies the raw process channel and lifecycle that connect them.

## Install

```sh
npm install @torkbot/code-mode @torkbot/code-mode-sandbox @torkbot/sandbox \
  @torkbot/sandbox-image-alpine-3.23-agent
```

## Usage

Define and boot the machine, then explicitly boot and dispose its code-mode
runtime:

```ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createClient,
  createToolbox,
} from "@torkbot/code-mode";
import { createSandboxNodeRuntime } from "@torkbot/code-mode-sandbox";
import { defineSandbox, fs, rootfs } from "@torkbot/sandbox";
import {
  image as alpine323Agent,
} from "@torkbot/sandbox-image-alpine-3.23-agent";

const workdir = process.cwd();
const torkbotDirectory = join(workdir, ".torkbot");
await mkdir(torkbotDirectory, { recursive: true });

const definition = defineSandbox({
  rootfs: rootfs.persistent({
    base: alpine323Agent,
    path: join(torkbotDirectory, "rootfs.qcow2"),
  }),
  resources: {
    cpus: 2,
    memoryMiB: 2048,
  },
});

await using sandbox = await definition.boot({
  mounts: {
    "/workspace": fs.bind({
      source: workdir,
      access: "ro",
      mask: {
        paths: ["/.git", "/.torkbot", "/node_modules"],
      },
    }),
  },
  cwd: "/workspace",
});

await using runtime = await createSandboxNodeRuntime(
  {
    sandbox,
    cwd: "/workspace",
    nodePath: "/usr/bin/node",
  },
  AbortSignal.timeout(10_000),
);

const client = createClient({
  runtime,
  toolbox: createToolbox([]),
});

const source = `
import { inspect } from "node:util";

export default function ({ console }: AgentProgramScope) {
  console.log(inspect({ cwd: process.cwd() }));
}
`.trimStart();

const validation = await client.validate(
  source,
  AbortSignal.timeout(5_000),
);
if (validation.kind === "invalid") {
  throw new Error(validation.report);
}

await client.run(source, {
  signal: AbortSignal.timeout(30_000),
  onTelemetry(event) {
    if (event.kind === "program-output") {
      process[event.stream].write(event.text);
    }
  },
});
```

This keeps durable guest rootfs changes in `.torkbot/rootfs.qcow2`. The
`.torkbot` directory is masked from `/workspace`, so the guest cannot access
its own VM state file through the workdir mount. The read-only mount also hides
the host's Git metadata and `node_modules`; platform-specific host dependencies
should not cross the VM boundary.

The absolute guest working directory and Node.js path are required. `cwd`
anchors native module resolution, and `nodePath` selects the executable
validated and launched by the runtime.

## Program contract

Programs are TypeScript-flavoured ECMAScript modules with native static imports
and a callable default export:

```ts
import { basename } from "node:path";

export default async function ({ codemode, console }: AgentProgramScope) {
  const result = await codemode.lookup({ name: basename("/tmp/example") });
  console.log(result);
}
```

The runner invokes the default export with the required `{ codemode, console }`
scope, awaits it, and ignores its fulfilled value. Only the passed `console` is
captured. Ambient or imported consoles remain ordinary guest process output and
are not reported as program output.

Captured console calls are formatted by Node.js and emitted as text chunks with
`stream: "stdout" | "stderr"`. Tool values crossing the runtime connection must
be JSON-compatible.

Every execution is a fresh root ESM module. Static imports use Node's native
resolution rooted at `cwd`. Imported dependencies may use Node's normal module
cache, and Node may retain unique root module records until the runtime is
disposed.

## Runtime lifecycle and cancellation

`createSandboxNodeRuntime(options, signal)` validates the selected guest
executable, starts one Node.js process, installs the version-matched runner, and
returns only after the runner is ready. The boot signal then detaches.

The connected runtime multiplexes executions over one raw full-duplex Sandbox
process pipe. An execution signal cancels only that execution and its active
tool calls; it does not terminate the process or affect other executions.
Sandbox process termination is reserved for failed boot and runtime disposal.

Disposing the runtime closes its connection, sends `SIGTERM` to the guest
runner, escalates to `SIGKILL` if necessary, and waits for the process to finish.
It never closes the caller-owned `SandboxInstance`. Dispose the runtime before
disposing the Sandbox.

Ambient stdout is drained so it cannot block the process. Ambient stderr is
retained only as a bounded tail for unexpected runner-process failures.

## Development

Requires Node.js 24 or newer.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## Releases

Every successful push to `main` produces an immutable package payload tied to
that commit. Publishing a GitHub release tagged `v<package version>` verifies
that exact CI artifact, derives the published `package.json` version from the
tag, and repacks the payload without rebuilding its code before publishing it
to npm.
