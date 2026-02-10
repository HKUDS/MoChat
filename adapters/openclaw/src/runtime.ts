import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setMochatRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getMochatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Mochat runtime not initialized");
  }
  return runtime;
}
