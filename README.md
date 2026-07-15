# @torkbot/code-mode-sandbox

Sandbox-backed runtime integration for [`@torkbot/code-mode`](https://github.com/torkbot/code-mode), built on [`@torkbot/sandbox`](https://github.com/torkbot/sandbox).

This repository currently contains project boilerplate only. The public API and implementation will be added separately.

## Development

Requires Node.js 24 or newer.

```sh
npm ci
npm test
npm run build
```

## Releases

Every successful push to `main` produces an immutable npm tarball tied to that commit. Publishing a GitHub release tagged `v<package version>` verifies and publishes that exact CI artifact to npm without rebuilding it.
