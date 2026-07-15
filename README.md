# @torkbot/code-mode-sandbox

Run [`@torkbot/code-mode`](https://github.com/torkbot/code-mode) programs
inside lifecycle-managed
[`@torkbot/sandbox`](https://github.com/torkbot/sandbox) microVMs.

This package owns the integration between code mode's runtime contract and
Sandbox VM execution. It boots a caller-defined Sandbox machine, provides a
code-mode runtime backed by Node.js inside that machine, and couples the runtime
and VM lifecycles so they are closed together.

The caller remains responsible for the Sandbox definition, including its image,
persistence, mounts, resources, and network access. The embedding application
remains responsible for machine identity, session reuse, and the runtime facts
presented to an agent.

`@torkbot/code-mode` remains responsible for tool declarations, source
validation, protocol routing, and telemetry. `@torkbot/sandbox` remains
responsible for isolated VM execution. This package adds only the integration
required to use those capabilities together.

## Install

```sh
npm install @torkbot/code-mode @torkbot/code-mode-sandbox @torkbot/sandbox
```

## Usage

Define the machine with Sandbox, then open a code-mode session for it:

```ts
import { createClient } from "@torkbot/code-mode";
import {
  openSandboxCodeMode,
} from "@torkbot/code-mode-sandbox";
import { defineSandbox } from "@torkbot/sandbox";

const definition = defineSandbox({
  rootfs: machineRootfs,
  resources: {
    cpus: 2,
    memoryMiB: 2048,
  },
});

await using session = await openSandboxCodeMode({
  definition,
  boot: {
    cwd: "/workspace",
  },
  nodePath: "/usr/bin/node",
});

const client = createClient({
  toolbox,
  runtime: session.runtime,
});
```

The absolute guest working directory and Node.js path are required because they
determine module resolution and the executable used for both validation and
execution. Reusing a persistent root filesystem remains a property of the
supplied Sandbox definition; this package does not infer machine identity or
persistence policy.

Callers that already own a booted `SandboxInstance` can construct a runtime
without transferring the VM lifecycle:

```ts
import { SandboxNodeRuntime } from "@torkbot/code-mode-sandbox";

const runtime = new SandboxNodeRuntime({
  sandbox,
  cwd: "/workspace",
  nodePath: "/usr/bin/node",
});
```

## Development

Requires Node.js 24 or newer.

```sh
npm ci
npm test
npm run build
```

## Releases

Every successful push to `main` produces an immutable npm tarball tied to that commit. Publishing a GitHub release tagged `v<package version>` verifies and publishes that exact CI artifact to npm without rebuilding it.
