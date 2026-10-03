import type { PaneInfo, PermissionMode, PermissionSettings, ThreadSummary } from "@kalcode/protocol";
import type { KalCodeClient, TerminalSize } from "../../../ipc/client.ts";
import { clampTerminalSize } from "../../../ipc/client.ts";
import { toKalCodeError } from "../../../ipc/errors.ts";
import type { ImportedTerminalImage } from "../../../ipc/terminalImages.ts";

/** Input is sent in pieces of at most this many UTF-16 units (≤ 24 KB of UTF-8), as for terminals. */
const WRITE_CHUNK = 8 * 1024;

/** Permission modes a pane can start in (Custom is set on the thread afterwards). */
export const PANE_CREATE_MODES: readonly PermissionMode[] = ["plan", "approve", "auto", "bypass"];

/** Providers that can run in a pane (mirrors `provider_pane_create`). */
export const PANE_PROVIDERS = ["claude-code", "codex", "gemini-cli"] as const;
export type PaneProviderId = (typeof PANE_PROVIDERS)[number];

export function isPaneProvider(providerId: string): providerId is PaneProviderId {
  return (PANE_PROVIDERS as readonly string[]).includes(providerId);
}

export interface CreatePaneInput {
  /** Defaults to Claude Code. */
  providerId?: PaneProviderId;
  providerAccountId?: string | null;
  workspaceId: string;
  permissionMode: PermissionMode;
  model?: string | null;
  /** Provider-native reasoning effort; missing means the provider default. */
  effort?: string | null;
  name?: string | null;
}

interface MemoryPaneTransport {
  attachProviderPane(threadId: string, onOutput: (bytes: Uint8Array) => void): Promise<number | null>;
}

/**
 * Splits input into writes no larger than the native limit without breaking a surrogate pair
 * (the same rule `KalCodeClient.writeTerminal` uses).
 */
export function splitInput(data: string, chunk = WRITE_CHUNK): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(data.length, start + chunk);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push(data.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * Coding agents start without approvals (owner directive 2026-10-03): Bypass, unless the saved
 * default is read-only Plan. Mirrors `startable_default_mode` in crates/permissions.
 */
export function paneStartMode(defaultMode: PermissionMode): PermissionMode {
  return defaultMode === "plan" ? "plan" : "bypass";
}

/** Read the canonical local setting before launch when the provider has not loaded it yet. */
export async function resolvePaneStartMode(
  settings: Pick<PermissionSettings, "defaultMode"> | null,
  loadSettings: () => Promise<Pick<PermissionSettings, "defaultMode">>,
): Promise<PermissionMode> {
  const canonical = settings ?? (await loadSettings());
  return paneStartMode(canonical.defaultMode);
}

/**
 * The provider pane commands (`provider_pane_*`, apps/desktop/src-tauri/src/provider_pane_commands.rs).
 * Plain commands go through the client's transport; output streams through a Tauri channel, or
 * through the in-memory runtime in ui-test builds.
 */
export class PaneChannel {
  constructor(private readonly client: KalCodeClient) {}

  private async call<T>(command: Parameters<KalCodeClient["transport"]["invoke"]>[0], args: Record<string, unknown>) {
    try {
      return await this.client.transport.invoke<T>(command, args);
    } catch (error) {
      throw toKalCodeError(error, command);
    }
  }

  create(input: CreatePaneInput): Promise<ThreadSummary> {
    return this.call("provider_pane_create", {
      providerId: input.providerId ?? "claude-code",
      providerAccountId: input.providerAccountId ?? null,
      workspaceId: input.workspaceId,
      model: input.model ?? null,
      effort: input.effort ?? null,
      permissionMode: input.permissionMode,
      name: input.name ?? null,
    });
  }

  info(threadId: string): Promise<PaneInfo | null> {
    return this.call("provider_pane_info", { threadId });
  }

  async write(threadId: string, data: string): Promise<void> {
    for (const part of splitInput(data)) {
      await this.call<void>("provider_pane_write", { threadId, data: part });
    }
  }

  /** Voice input uses the same PTY path with native instance and lifecycle guards at each write. */
  async writeVoice(threadId: string, instanceId: string, data: string): Promise<void> {
    for (const part of splitInput(data)) {
      await this.call<void>("provider_pane_write", { threadId, instanceId, data: part, voice: true });
    }
  }

  importImage(threadId: string, instanceId: string, pngBase64: string): Promise<ImportedTerminalImage> {
    return this.client.importTerminalImage({ kind: "agent", threadId, instanceId }, pngBase64);
  }

  discardImage(threadId: string, instanceId: string, imageId: string): Promise<void> {
    return this.client.discardTerminalImage({ kind: "agent", threadId, instanceId }, imageId);
  }

  resize(threadId: string, size: TerminalSize): Promise<void> {
    return this.call("provider_pane_resize", { threadId, ...clampTerminalSize(size) });
  }

  ack(attachmentId: number, bytes: number): Promise<boolean> {
    return this.call("provider_pane_ack", {
      attachmentId,
      bytes: Math.max(0, Math.min(0xffffffff, Math.floor(bytes))),
    });
  }

  detach(attachmentId: number): Promise<boolean> {
    return this.call("provider_pane_detach", { attachmentId });
  }

  /** Streams output (replay first); resolves to the attachment id, or null if the pane is gone. */
  async attach(threadId: string, onOutput: (bytes: Uint8Array) => void): Promise<number | null> {
    try {
      const transport = this.client.transport;
      if (transport.kind === "memory") {
        return await (transport as unknown as MemoryPaneTransport).attachProviderPane(threadId, onOutput);
      }
      const { invoke, Channel } = await import("@tauri-apps/api/core");
      const channel = new Channel<ArrayBuffer>();
      channel.onmessage = (buffer) => onOutput(new Uint8Array(buffer));
      return await invoke<number | null>("provider_pane_attach", { threadId, onOutput: channel });
    } catch (error) {
      throw toKalCodeError(error, "provider_pane_attach");
    }
  }
}
