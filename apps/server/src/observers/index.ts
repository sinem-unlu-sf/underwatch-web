/**
 * Independent observers for supervised / verification runs. Currently: Tetragon (eBPF, kernel level) via
 * @kw/observer-tetragon. Events are basis "observed", schema source "kernel_tracer" (the schema has no "tetragon"
 * literal; source_native_key starts with "tetragon:" and the Evidence names the collector).
 */
import type { TetragonHealth } from "@kw/observer-tetragon";
import type { KernelRunOptions, TetragonApi } from "./tetragon-run";

export * from "./tetragon-run";
export * from "./kernel-evidence";
export * from "./enforcement-content";
export * from "./ingest";

/** What a container runner needs to run one agent container under Tetragon. */
export interface KernelHarnessOptions {
  api: TetragonApi;
  health: TetragonHealth;
  run: KernelRunOptions;
}
