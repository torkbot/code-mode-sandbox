# @torkbot/code-mode-sandbox

Run [`@torkbot/code-mode`](https://github.com/torkbot/code-mode) programs
with Node.js 24 inside
[`@torkbot/sandbox`](https://github.com/torkbot/sandbox) microVMs.

This package owns the integration between code mode's runtime contract and
Sandbox VM execution. It adapts a caller-owned, booted `SandboxInstance` into
the execution host required by `Node24Runtime`; composing those values produces
a code-mode runtime backed by Node.js inside that machine.

The caller owns the Sandbox lifecycle. It chooses the image, persistence,
mounts, resources, network access, machine identity, and reuse policy; boots the
machine; keeps it open while the runtime is in use; and closes it afterward.
The Sandbox runtime host owns only the guest processes it launches through
`Node24Runtime`. This package does not boot, pool, reuse, or close Sandbox
machines.

`@torkbot/code-mode` remains responsible for tool declarations, source
validation, protocol routing, and telemetry. `@torkbot/sandbox` remains
responsible for isolated VM execution. This package adds only the integration
required to use those capabilities together. The runtime channel is the
Sandbox process pipe's standard readable and writable Web Streams pair.

## Install

```sh
npm install @torkbot/code-mode @torkbot/code-mode-sandbox @torkbot/sandbox
```

## Usage

Define and boot the machine with Sandbox, then adapt that machine for code mode:

```ts
import { createClient } from "@torkbot/code-mode";
import { Node24Runtime } from "@torkbot/code-mode/node";
import { createSandboxNodeRuntimeHost } from "@torkbot/code-mode-sandbox";
import { defineSandbox } from "@torkbot/sandbox";

const definition = defineSandbox({
  rootfs: machineRootfs,
  resources: {
    cpus: 2,
    memoryMiB: 2048,
  },
});

await using sandbox = await definition.boot({
  cwd: "/workspace",
});

const runtime = new Node24Runtime(
  createSandboxNodeRuntimeHost({
    sandbox,
    cwd: "/workspace",
    nodePath: "/usr/bin/node",
  }),
);

const client = createClient({
  toolbox,
  runtime,
});
```

The absolute guest working directory and Node.js path are required because they
determine module resolution and the executable used for both validation and
execution. The Sandbox instance must remain open until every runtime instance
started through the composed runtime has finished.

## Development

Requires Node.js 24 or newer.

```sh
npm ci
npm test
npm run build
```

## Releases

Every successful push to `main` produces an immutable npm tarball tied to that commit. Publishing a GitHub release tagged `v<package version>` verifies and publishes that exact CI artifact to npm without rebuilding it.
