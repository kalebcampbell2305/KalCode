/**
 * OS-specific process probes. Windows is implemented; macOS and Linux plug in here later
 * (process tree via `ps`/procfs, window visibility via the platform's window server).
 */
import { arch, cpus, platform, release, totalmem, version } from "node:os";
import { createWindowsProbe } from "./windows.ts";

export interface ProcessSample {
  pid: number;
  name: string;
  /** `main` for the app; for WebView2 helpers the Chromium process type (renderer, gpu-process, …). */
  role: string;
  /** Resident set / working set, bytes. */
  workingSet: number;
  /** Private (committed, non-shared) bytes. */
  privateBytes: number;
  /** User + kernel CPU time consumed so far, ms. */
  cpuMs: number;
}

export interface WindowWatcher {
  /** Starts watching `pid`; resolves with the epoch ms at which its main window became visible. */
  watch(pid: number): Promise<number>;
  dispose(): void;
}

export interface ProcessProbe {
  /** The process and all of its descendants (the WebView runtime's processes included). */
  tree(rootPid: number): Promise<ProcessSample[]>;
  /** A watcher that is already running, so starting the app is not delayed by probe startup. */
  createWindowWatcher(timeoutMs: number): Promise<WindowWatcher>;
  /** Asks the app to close as a user would (window close), without forcing. */
  requestClose(pid: number): void;
  forceKill(pid: number): void;
}

export interface MachineInfo {
  platform: string;
  osRelease: string;
  osVersion: string;
  arch: string;
  cpuModel: string;
  logicalCores: number;
  totalMemoryGB: number;
  node: string;
}

export function machineInfo(): MachineInfo {
  const cpu = cpus();
  return {
    platform: platform(),
    osRelease: release(),
    osVersion: version(),
    arch: arch(),
    cpuModel: cpu[0]?.model.trim() ?? "unknown",
    logicalCores: cpu.length,
    totalMemoryGB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
  };
}

/** Key for baselines and budgets, e.g. `windows-x64`. */
export function platformKey(): string {
  const os = platform() === "win32" ? "windows" : platform() === "darwin" ? "macos" : platform();
  return `${os}-${arch()}`;
}

export function createProbe(): ProcessProbe {
  if (platform() === "win32") return createWindowsProbe();
  throw new Error(
    `The performance harness supports Windows only for now (this is ${platform()}). ` +
      "Add a ProcessProbe for this OS in tests/perf/lib/platform.ts.",
  );
}
