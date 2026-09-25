/**
 * Provider panes (Z7-W4) for the in-memory runtime (unit tests and the `ui-test` build only).
 * Mirrors `apps/desktop/src-tauri/src/provider_pane_commands.rs`: the same commands, argument
 * validation and error codes, with a simulated provider TUI instead of a real CLI in a PTY.
 *
 * The simulated provider behaves like the fake provider the native tests use:
 *   run <command>   a tool call. `git push …`, `deploy …` and `npm install …` ask the permission
 *                   engine (a KalCode approval) in engine routing; other commands just run.
 *   say <text>      prints text only (prose never changes status)
 *   exit            the provider exits (thread completed)
 * Status goes through the memory thread runtime (one status machine, as native).
 *
 * `?panes=limited | provider-prompt | off` or `window.__kalcodeMemory.panes.configure(...)`
 * select the hook-channel state, the decision routing, or turn the feature off.
 */
import type {
  ApprovalView,
  DecisionRouting,
  HookChannelState,
  IpcError,
  PaneInfo,
  PermissionMode,
  ThreadStatus,
  ThreadSummary,
} from "@kalcode/protocol";
import type { PermissionMemory } from "./permissions.ts";
import { nameFromPrompt, type ThreadsMemory } from "./threads.ts";

type Handler = (args: Record<string, unknown>) => unknown;
export type PaneCommand =
  | "provider_pane_create"
  | "provider_pane_ack"
  | "provider_pane_detach"
  | "provider_pane_write"
  | "provider_pane_resize"
  | "provider_pane_info";

export interface PaneOptions {
  /** Hook channel of new panes: "active", or "limited" (no hook events arrive). */
  hookChannel: "active" | "limited";
  routing: DecisionRouting;
  /** false: the feature flag is off (every command refuses). */
  enabled: boolean;
}

export interface PaneControls {
  configure(options: Partial<PaneOptions>): void;
  /** Output of a pane as text (tests). */
  text(threadId: string): string;
}

export interface PanesMemory {
  handlers: Record<PaneCommand, Handler>;
  attach(threadId: string, onOutput: (bytes: Uint8Array) => void): Promise<number | null>;
  /** An approval was answered (forwarded from the permission engine, like native events). */
  resolveApproval(view: ApprovalView): void;
  controls: PaneControls;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_WRITE = 64 * 1024;
const SCROLLBACK = 512 * 1024;
export const MEMORY_PANE_BANNER = "KalCode fake provider (interactive, ui-test). No AI service is contacted.";

function fail(error: IpcError): never {
  throw error;
}

function invalid(code: string, message: string): never {
  return fail({ category: "validation", code, message, retryable: false });
}

interface Pane {
  thread: ThreadSummary;
  output: string;
  listeners: Map<number, (bytes: Uint8Array) => void>;
  line: string;
  running: boolean;
  exitCode: number | null;
  hookChannel: HookChannelState;
  routing: DecisionRouting;
  pending: { requestId: string } | null;
  /** The pane's own prompt is waiting for y/n (provider-prompt routing or limited status). */
  askingInPane: boolean;
  titled: boolean;
  timers: ReturnType<typeof setTimeout>[];
}

function readOptions(): PaneOptions {
  const value = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("panes");
  return {
    hookChannel: value === "limited" ? "limited" : "active",
    routing: value === "provider-prompt" || value === "limited" ? "provider_prompt" : "engine",
    enabled: value !== "off",
  };
}

const APPROVAL_KINDS: [RegExp, "push" | "deploy" | "install"][] = [
  [/^git\s+push\b/, "push"],
  [/^(deploy|vercel|wrangler)\b/, "deploy"],
  [/^(npm|pnpm|yarn)\s+(install|add|i)\b/, "install"],
];

export function createPanesMemory(options: {
  requireCore: () => void;
  threads: ThreadsMemory;
  permissions: PermissionMemory;
  /** Runs before a pane is created (like native `ensure_providers`). */
  beforeCreate?: () => Promise<void>;
}): PanesMemory {
  const { requireCore, threads, permissions } = options;
  let config: PaneOptions = readOptions();
  const panes = new Map<string, Pane>();
  let nextAttach = 1;
  const attachments = new Map<number, string>();
  const encoder = new TextEncoder();

  const requireEnabled = () => {
    requireCore();
    if (!config.enabled) invalid("provider_panes_unavailable", "Provider panes aren't available in this build yet.");
  };

  const pane = (args: Record<string, unknown>): Pane => {
    requireEnabled();
    const id = args.threadId;
    if (typeof id !== "string" || !UUID.test(id)) invalid("invalid_thread", "That thread id isn't valid.");
    const found = panes.get(id as string);
    if (!found) invalid("pane_not_running", "This pane's provider has ended. Resume the thread to start it again.");
    return found as Pane;
  };

  const print = (p: Pane, text: string) => {
    p.output = (p.output + text).slice(-SCROLLBACK);
    const bytes = encoder.encode(text);
    for (const listener of p.listeners.values()) listener(bytes);
  };

  const status = (p: Pane, to: ThreadStatus, activity: string | null = null, pendingApprovals?: number) => {
    // Without hook events (limited status) KalCode only sees the process.
    if (p.hookChannel === "limited" && to !== "completed" && to !== "failed") return;
    threads.setPaneStatus(p.thread.id, to, activity, pendingApprovals);
  };

  const later = (p: Pane, ms: number, fn: () => void) => {
    p.timers.push(
      setTimeout(() => {
        if (p.running) fn();
      }, ms),
    );
  };

  const prompt = (p: Pane) => print(p, "\r\n> ");

  const finishTool = (p: Pane, ran: boolean, blockedReason?: string) => {
    print(p, ran ? "\r\nRAN Bash" : `\r\n${blockedReason ?? "DENIED IN PROVIDER PROMPT"}`);
    status(p, "idle", null, 0);
    prompt(p);
  };

  const runCommand = (p: Pane, command: string) => {
    status(p, "running_command", `Run ${command}`);
    const kind = APPROVAL_KINDS.find(([pattern]) => pattern.test(command))?.[1];
    if (p.routing === "provider_prompt" || p.hookChannel === "limited") {
      // KalCode records the call but the provider's own prompt decides, in the pane.
      later(p, 60, () => {
        status(p, "waiting_for_user", "Answer in Claude Code");
        p.askingInPane = true;
        print(p, "\r\n[fake prompt] Allow Bash? (y/n) ");
      });
      return;
    }
    if (!kind) {
      later(p, 200, () => finishTool(p, true));
      return;
    }
    later(p, 60, () => {
      const view = permissions.openRequest(
        {
          threadId: p.thread.id,
          threadName: p.thread.name,
          workspaceId: p.thread.workspaceId,
          workspaceName: p.thread.workspaceName,
          providerId: p.thread.providerId,
          providerName: p.thread.providerName,
          mode: p.thread.permissionMode,
        },
        kind,
      );
      p.pending = { requestId: view.id };
      threads.setPaneStatus(p.thread.id, "waiting_for_permission", `Waiting for approval: Run ${command}`, 1);
    });
  };

  const submit = (p: Pane, raw: string) => {
    const line = raw.trim();
    if (p.askingInPane) {
      p.askingInPane = false;
      finishTool(p, line.toLowerCase() === "y");
      return;
    }
    if (!line) {
      prompt(p);
      return;
    }
    if (line === "exit") {
      end(p, 0);
      return;
    }
    if (!p.titled) {
      p.titled = true;
      const current = threads.handlers.thread_get({ threadId: p.thread.id }) as ThreadSummary;
      if (current.name === "New thread")
        p.thread = threads.handlers.thread_rename({
          threadId: p.thread.id,
          name: nameFromPrompt(line),
        }) as ThreadSummary;
    }
    status(p, "active");
    if (line.startsWith("run ")) {
      runCommand(p, line.slice(4).trim());
    } else if (line.startsWith("say ")) {
      later(p, 40, () => {
        print(p, `\r\n${line.slice(4)}`);
        status(p, "idle");
        prompt(p);
      });
    } else {
      later(p, 80, () => {
        print(p, "\r\n(fake) ok");
        status(p, "idle");
        prompt(p);
      });
    }
  };

  const end = (p: Pane, code: number, stopped = false) => {
    if (!p.running) return;
    p.running = false;
    p.exitCode = code;
    p.hookChannel = "ended";
    p.pending = null;
    for (const timer of p.timers) clearTimeout(timer);
    p.timers = [];
    print(p, stopped ? "\r\n[stopped by KalCode]\r\n" : "\r\n[process exited]\r\n");
    // A stop is recorded by the thread runtime itself (interrupted); an exit completes it.
    if (!stopped) threads.setPaneStatus(p.thread.id, code === 0 ? "completed" : "failed", null, 0);
  };

  const info = (p: Pane): PaneInfo => ({
    threadId: p.thread.id,
    providerId: p.thread.providerId,
    hookChannel: p.hookChannel,
    decisionRouting: p.routing,
    kalcodeAnswersApprovals: p.routing === "engine" && p.hookChannel === "active",
    running: p.running,
    exitCode: p.exitCode,
  });

  const handlers: Record<PaneCommand, Handler> = {
    provider_pane_create: async (args) => {
      requireEnabled();
      await options.beforeCreate?.();
      if (args.providerId !== "claude-code")
        invalid("provider_pane_unsupported", "Only Claude Code runs in a pane today.");
      const mode = args.permissionMode as PermissionMode;
      if (mode === "bypass" && args.confirmBypass !== true)
        invalid("bypass_not_confirmed", "Bypass needs your explicit confirmation.");
      let created: Pane | null = null;
      const thread = threads.createPaneThread(args, () => {
        if (created) end(created, 1, true);
      });
      const p: Pane = {
        thread,
        output: "",
        listeners: new Map(),
        line: "",
        running: true,
        exitCode: null,
        hookChannel: "waiting",
        routing: config.routing,
        pending: null,
        askingInPane: false,
        titled: false,
        timers: [],
      };
      created = p;
      panes.set(thread.id, p);
      const limited = config.hookChannel === "limited";
      later(p, 40, () => {
        print(p, `${MEMORY_PANE_BANNER}\r\n> `);
        if (limited) {
          p.hookChannel = "limited";
          threads.setPaneStatus(thread.id, "idle", null);
        } else {
          p.hookChannel = "active";
          status(p, "idle");
        }
      });
      return thread;
    },
    provider_pane_info: (args) => {
      requireEnabled();
      const id = args.threadId;
      if (typeof id !== "string" || !UUID.test(id)) invalid("invalid_thread", "That thread id isn't valid.");
      const p = panes.get(id as string);
      return p ? info(p) : null;
    },
    provider_pane_write: (args) => {
      const p = pane(args);
      const data = args.data;
      if (typeof data !== "string" || new TextEncoder().encode(data).length > MAX_WRITE)
        invalid("provider_pane_failed", "That input is too large.");
      if (!p.running)
        invalid("pane_not_running", "This pane's provider has ended. Resume the thread to start it again.");
      for (const ch of data as string) {
        if (ch === "\r" || ch === "\n") {
          const line = p.line;
          p.line = "";
          submit(p, line);
        } else if (ch === "\u007f" || ch === "\b") {
          if (p.line) {
            p.line = p.line.slice(0, -1);
            print(p, "\b \b");
          }
        } else if (ch >= " ") {
          p.line += ch;
          print(p, ch);
        }
      }
      return null;
    },
    provider_pane_resize: (args) => {
      pane(args);
      const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 2 && (n as number) <= 1000;
      if (!ok(args.cols) || !ok(args.rows)) invalid("provider_pane_failed", "That pane size is out of range.");
      return null;
    },
    provider_pane_ack: () => true,
    provider_pane_detach: (args) => {
      const id = args.attachmentId as number;
      const threadId = attachments.get(id);
      attachments.delete(id);
      return threadId ? (panes.get(threadId)?.listeners.delete(id) ?? false) : false;
    },
  };

  return {
    handlers,
    async attach(threadId, onOutput) {
      await Promise.resolve();
      requireEnabled();
      const p = panes.get(threadId);
      if (!p) return null;
      const id = nextAttach++;
      onOutput(encoder.encode(p.output));
      p.listeners.set(id, onOutput);
      attachments.set(id, threadId);
      return id;
    },
    resolveApproval(view) {
      for (const p of panes.values()) {
        if (p.pending?.requestId !== view.id || !p.running) continue;
        p.pending = null;
        if (view.status === "approved") finishTool(p, true);
        else finishTool(p, false, "BLOCKED BY HOOK: KalCode denied this action (its policy, or your answer).");
      }
    },
    controls: {
      configure(next) {
        config = { ...config, ...next };
      },
      text: (threadId) => panes.get(threadId)?.output ?? "",
    },
  };
}
