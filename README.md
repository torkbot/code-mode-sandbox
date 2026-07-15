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
npm install @torkbot/code-mode-sandbox
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
