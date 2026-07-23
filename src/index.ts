import {
  createRuntimeFactory,
  type RuntimeFactory,
} from "@torkbot/code-mode/runtime";

import {
  sandboxNodeRuntimeDriver,
  type SandboxNodeRuntimeOptions,
} from "./driver.ts";

export type { SandboxNodeRuntimeOptions } from "./driver.ts";

/**
 * Boot one persistent, multiplexed Node.js 24 Runtime in a caller-owned Sandbox.
 *
 * The signal governs boot through runner readiness and then detaches. Runtime
 * disposal stops only the guest runner process and waits for it to finish; the
 * caller remains responsible for disposing the Sandbox instance.
 */
export const createSandboxNodeRuntime: RuntimeFactory<SandboxNodeRuntimeOptions> =
  createRuntimeFactory(sandboxNodeRuntimeDriver);
