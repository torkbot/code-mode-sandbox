# @torkbot/code-mode-sandbox

Run [`@torkbot/code-mode`](https://github.com/torkbot/code-mode) programs
with Node.js 24 inside
[`@torkbot/sandbox`](https://github.com/torkbot/sandbox) microVMs.

This package owns the integration between code mode's runtime contract and
Sandbox VM execution. It creates a Node.js 24 code-mode runtime backed by a
caller-owned, booted `SandboxInstance`.

The caller owns the Sandbox lifecycle. It chooses the image, persistence,
mounts, resources, network access, machine identity, and reuse policy; boots the
machine; keeps it open while the runtime is in use; and closes it afterward.
The Sandbox runtime owns only the guest processes it launches. This package
does not boot, pool, reuse, or close Sandbox machines.

`@torkbot/code-mode` remains responsible for tool declarations, source
validation, protocol routing, and telemetry. `@torkbot/sandbox` remains
responsible for isolated VM execution. This package adds only the integration
required to use those capabilities together. The runtime channel is the
Sandbox process pipe's standard readable and writable Web Streams pair.

## Install

```sh
npm install @torkbot/code-mode @torkbot/code-mode-sandbox @torkbot/sandbox \
  @torkbot/sandbox-image-alpine-3.23-agent
```

## Usage

Define and boot the machine with Sandbox, then create its code-mode runtime:

```ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createClient } from "@torkbot/code-mode";
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

const runtime = createSandboxNodeRuntime({
  sandbox,
  cwd: "/workspace",
  nodePath: "/usr/bin/node",
});

const client = createClient({
  toolbox,
  runtime,
});
```

This keeps durable guest rootfs changes in `.torkbot/rootfs.qcow2`. The
`.torkbot` directory is masked from `/workspace`, so the guest cannot access
its own VM state file through the workdir mount. The mount is read-only and
also hides the host's Git metadata and `node_modules`; platform-specific host
dependencies should not cross the VM boundary.

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

Every successful push to `main` produces an immutable package payload tied to
that commit. Publishing a GitHub release tagged `v<package version>` verifies
that exact CI artifact, derives the published `package.json` version from the
tag, and repacks the payload without rebuilding its code before publishing it
to npm.
