/**
 * In-memory workspaces and terminals for the `ui-test` build and unit tests ONLY (see
 * memoryTransport.ts). Never bundled into development or production builds. It mirrors native
 * validation, error codes and event semantics; the "shell" is a tiny fake that echoes input,
 * prints a prompt and understands a handful of commands, so UI tests exercise real flows.
 */
import type { EventPayload, IpcError, ShellOption, TerminalInfo, TerminalStatus, Workspace } from "@kalcode/protocol";
import { getPlan } from "@kalcode/protocol";

export type EmitWithWorkspace = (event: EventPayload, workspaceId: string) => void;

/** A folder the fake native picker "returns" next: a name under ~\Projects, or null = cancel. */
export type PickedFolder = string | null;

export interface MemoryWorkspacesOptions {
  emit: EmitWithWorkspace;
  requireCore: () => void;
  /** Preloads workspaces and tabs (screenshots, Dashboard tests). */
  preload?: boolean;
}

export interface MemoryWorkspaces {
  handlers: Record<string, (args: Record<string, unknown>) => unknown>;
  attachTerminal(terminalId: string, onOutput: (bytes: Uint8Array) => void): Promise<number | null>;
  /** Test hook: the folders the fake picker returns next (null = the user cancels). */
  queueFolders(...folders: PickedFolder[]): void;
  /** Test hook: simulates a folder moved or deleted outside KalCode. */
  makeUnavailable(name: string): void;
  /** Test hook: the fake processes still running (a closed tab must end its process). */
  runningProcessCount(): number;
}

// The in-memory backend has no verified plan, so it applies the Free cap, as native does.
const FREE_TERMINALS_PER_WORKSPACE = getPlan("free").limits.terminalsPerWorkspace;
const MAX_WRITE_BYTES = 64 * 1024;
const SCROLLBACK_BYTES = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOME = "C:\\Users\\you";

const SHELLS: ShellOption[] = [
  { id: "pwsh", name: "PowerShell 7", isDefault: true },
  { id: "powershell", name: "Windows PowerShell", isDefault: false },
  { id: "cmd", name: "Command Prompt", isDefault: false },
  { id: "git-bash", name: "Git Bash", isDefault: false },
];

const rejected = (): IpcError => ({
  category: "internal",
  code: "ipc_rejected",
  message: "KalCode couldn't complete that request.",
  retryable: false,
});

function fail(error: IpcError): never {
  throw error;
}

const validation = (code: string, message: string): IpcError => ({
  category: "validation",
  code,
  message,
  retryable: false,
});

function requireId(value: unknown): string {
  if (typeof value !== "string") fail(rejected());
  if (!UUID.test(value)) fail(validation("invalid_id", "Invalid identifier."));
  return value.toLowerCase();
}

/** Mirrors Tauri's u16 deserialization, then native's 2..=1000 check. */
function requireSize(args: Record<string, unknown>): { cols: number; rows: number } {
  const { cols, rows } = args;
  const u16 = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 65_535;
  if (!u16(cols) || !u16(rows)) fail(rejected());
  const ok = (n: number) => n >= 2 && n <= 1000;
  if (!ok(cols as number) || !ok(rows as number)) {
    fail(validation("invalid_size", "Terminal size must be between 2 and 1000 columns and rows."));
  }
  return { cols: cols as number, rows: rows as number };
}

const notFound = (what: string) => validation("not_found", `That ${what} no longer exists.`);
const notRunning = (): IpcError => ({
  category: "terminal",
  code: "terminal_not_running",
  message: "This terminal has ended. Restart it to continue.",
  retryable: false,
});
const folderMissing = (): IpcError => ({
  category: "filesystem",
  code: "folder_not_found",
  message: "This workspace's folder no longer exists. It may have been moved or deleted.",
  retryable: false,
});

interface Session {
  scrollback: Uint8Array[];
  scrollbackBytes: number;
  listeners: Set<(bytes: Uint8Array) => void>;
  line: string;
  exited: boolean;
}

interface Tab {
  info: TerminalInfo;
  session: Session | null;
}

const encoder = new TextEncoder();
const ESC = "\x1b";
const c = (code: string, text: string) => `${ESC}[${code}m${text}${ESC}[0m`;

export function createMemoryWorkspaces({
  emit,
  requireCore,
  preload = false,
}: MemoryWorkspacesOptions): MemoryWorkspaces {
  const workspaces = new Map<string, Workspace>();
  const tabs = new Map<string, Tab>();
  let activeWorkspaceId: string | null = null;
  const pickQueue: PickedFolder[] = [];
  const defaultPicks = ["kalcode-site", "api-server", "design-notes"];
  let clock = Date.now() - 120_000;
  const now = () => {
    clock += 1000;
    return new Date(clock).toISOString();
  };

  const folderPath = (name: string) => `${HOME}\\Projects\\${name}`;
  const displayPath = (name: string) => `~\\Projects\\${name}`;

  const sortedWorkspaces = () => [...workspaces.values()].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));

  const tabsOf = (workspaceId: string) =>
    [...tabs.values()]
      .filter((t) => t.info.workspaceId === workspaceId)
      .sort((a, b) => a.info.position - b.info.position);

  const status = (tab: Tab): TerminalStatus => tab.info.status;

  const deliver = (session: Session, text: string) => {
    if (session.exited && text) return;
    const bytes = encoder.encode(text);
    session.scrollback.push(bytes);
    session.scrollbackBytes += bytes.length;
    while (session.scrollbackBytes > SCROLLBACK_BYTES && session.scrollback.length > 1) {
      session.scrollbackBytes -= session.scrollback.shift()?.length ?? 0;
    }
    // Native delivers from its reader thread: asynchronously, in order.
    const targets = [...session.listeners];
    setTimeout(() => {
      for (const listener of targets) if (session.listeners.has(listener)) listener(bytes);
    }, 0);
  };

  const promptFor = (tab: Tab) => {
    const workspace = workspaces.get(tab.info.workspaceId);
    const where = workspace ? workspace.rootPath : HOME;
    switch (tab.info.shellId) {
      case "cmd":
        return `${where}>`;
      case "git-bash":
        return `${c("32", "you@kalcode")} ${c("35", "MINGW64")} ${c("33", workspace ? `~/Projects/${workspace.name}` : "~")}\r\n$ `;
      default:
        return `PS ${where}> `;
    }
  };

  const banner = (tab: Tab) =>
    tab.info.shellId === "cmd"
      ? "Microsoft Windows [Version 10.0.26200]\r\n(c) Microsoft Corporation. All rights reserved.\r\n\r\n"
      : tab.info.shellId === "git-bash"
        ? ""
        : "";

  const listing = () =>
    [
      `${c("1;34", "src")}/  ${c("1;34", "docs")}/  ${c("1;34", "tests")}/  ${c("1;32", "build.sh")}*  README.md  package.json`,
    ].join("\r\n");

  const gitLog = () =>
    [
      `* ${c("33", "4c8d2f1")} ${c("1;36", "(")}${c("1;36", "HEAD -> ")}${c("1;32", "main")}${c("1;36", ", ")}${c("1;31", "origin/main")}${c("1;36", ")")} Open workspaces from the native picker`,
      `* ${c("33", "a17be09")} Stream terminal output over raw channels`,
      `${c("31", "|")}${c("32", "\\")}  `,
      `${c("31", "|")} * ${c("33", "9f03c44")} ${c("1;36", "(")}${c("1;32", "feature/tabs")}${c("1;36", ")")} Keep tabs alive while switching`,
      `${c("31", "|")}${c("31", "/")}  `,
      `* ${c("33", "5e2a7d0")} Design terminal palettes for both themes`,
      `* ${c("33", "0b3f6a2")} ${c("1;33", "(tag: v0.1.0)")} First release`,
    ].join("\r\n");

  const endSession = (tab: Tab, code: number, closedByUser: boolean) => {
    const session = tab.session;
    if (!session || session.exited) return;
    session.exited = true;
    session.listeners.clear();
    if (closedByUser) {
      emit(
        { type: "shell.completed", payload: { terminalId: tab.info.id, exitCode: code, closedByUser: true } },
        tab.info.workspaceId,
      );
      return;
    }
    tab.info = { ...tab.info, status: "exited", endedAt: now(), exitCode: code };
    emit(
      code === 0
        ? { type: "shell.completed", payload: { terminalId: tab.info.id, exitCode: 0, closedByUser: false } }
        : { type: "shell.failed", payload: { terminalId: tab.info.id, exitCode: code } },
      tab.info.workspaceId,
    );
  };

  const run = (tab: Tab, command: string) => {
    const session = tab.session;
    if (!session) return;
    const [name = "", ...rest] = command.trim().split(/\s+/);
    const workspace = workspaces.get(tab.info.workspaceId);
    const out = (text: string) => deliver(session, `${text}\r\n`);
    switch (name.toLowerCase()) {
      case "":
        break;
      case "echo":
        out(rest.join(" ").replaceAll("%OS%", "Windows_NT"));
        break;
      case "pwd":
      case "cd":
        out(workspace?.rootPath ?? HOME);
        break;
      case "ls":
      case "dir":
        out(listing());
        break;
      case "git":
        if (rest[0] === "log") out(gitLog());
        else out(`${c("1;31", "fatal:")} only 'git log' works in this test shell`);
        break;
      case "colors":
        out([0, 1, 2, 3, 4, 5, 6, 7].map((n) => `${c(`3${n}`, `color${n}`)} ${c(`9${n}`, `bright${n}`)}`).join("  "));
        break;
      case "cls":
      case "clear":
        deliver(session, `${ESC}[2J${ESC}[H`);
        break;
      case "exit": {
        const code = Number.parseInt(rest[0] ?? "0", 10);
        endSession(tab, Number.isFinite(code) ? code : 0, false);
        return;
      }
      default:
        out(`${c("31", `${name}: the term '${name}' is not recognized in this test shell.`)}`);
    }
    deliver(session, promptFor(tab));
  };

  const input = (tab: Tab, data: string) => {
    const session = tab.session;
    if (!session) return;
    for (const ch of data) {
      if (ch === "\r") {
        deliver(session, "\r\n");
        const line = session.line;
        session.line = "";
        run(tab, line);
        if (session.exited) return;
      } else if (ch === "\x7f" || ch === "\b") {
        if (session.line.length > 0) {
          session.line = session.line.slice(0, -1);
          deliver(session, "\b \b");
        }
      } else if (ch === "\x03") {
        session.line = "";
        deliver(session, `^C\r\n${promptFor(tab)}`);
      } else if (ch >= " ") {
        session.line += ch;
        deliver(session, ch);
      }
      // Other control input (arrows, terminal reports) is ignored by this fake shell.
    }
  };

  const startSession = (tab: Tab) => {
    tab.session = { scrollback: [], scrollbackBytes: 0, listeners: new Set(), line: "", exited: false };
    tab.info = { ...tab.info, status: "running", startedAt: now(), endedAt: null, exitCode: null };
    const shell = SHELLS.find((s) => s.id === tab.info.shellId);
    emit(
      {
        type: "shell.started",
        payload: { terminalId: tab.info.id, shellId: tab.info.shellId, shellName: shell?.name ?? tab.info.title },
      },
      tab.info.workspaceId,
    );
    deliver(tab.session, `${banner(tab)}${promptFor(tab)}`);
  };

  const openFolder = (name: string, options: { emitEvent?: boolean; available?: boolean } = {}): Workspace => {
    const existing = [...workspaces.values()].find((w) => w.name === name);
    const at = now();
    let workspace: Workspace;
    if (existing) {
      workspace = { ...existing, lastOpenedAt: at };
    } else {
      workspace = {
        id: crypto.randomUUID(),
        name,
        rootPath: folderPath(name),
        displayPath: displayPath(name),
        createdAt: at,
        lastOpenedAt: at,
        activeTerminalId: null,
        available: options.available ?? true,
      };
    }
    workspaces.set(workspace.id, workspace);
    activeWorkspaceId = workspace.id;
    if (options.emitEvent !== false) {
      emit(
        existing
          ? { type: "workspace.opened", payload: { workspaceId: workspace.id, name } }
          : { type: "workspace.created", payload: { workspaceId: workspace.id, name } },
        workspace.id,
      );
    }
    return workspace;
  };

  const addTab = (workspace: Workspace, shellId: string): Tab => {
    const shell = SHELLS.find((s) => s.id === shellId) ?? SHELLS[0];
    const position = Math.max(-1, ...tabsOf(workspace.id).map((t) => t.info.position)) + 1;
    const tab: Tab = {
      info: {
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        shellId: shell?.id ?? "pwsh",
        title: shell?.name ?? "PowerShell 7",
        position,
        status: "ended_by_app",
        startedAt: null,
        endedAt: null,
        exitCode: null,
      },
      session: null,
    };
    tabs.set(tab.info.id, tab);
    workspaces.set(workspace.id, { ...workspace, activeTerminalId: tab.info.id });
    return tab;
  };

  if (preload) {
    // A workspace whose folder was moved outside KalCode, and an older one.
    openFolder("old-prototype", { emitEvent: false, available: false });
    const api = openFolder("api-server", { emitEvent: true });
    // A tab restored after KalCode closed while its shell was running.
    const restored = addTab(api, "pwsh");
    restored.info = { ...restored.info, startedAt: now(), endedAt: now() };
    const site = openFolder("kalcode-site", { emitEvent: true });
    const first = addTab(site, "pwsh");
    startSession(first);
    input(first, "git log --oneline --graph --color\r");
    const second = addTab(site, "git-bash");
    startSession(second);
    input(second, "ls\r");
    const third = addTab(site, "cmd");
    startSession(third);
    input(third, "exit 1\r");
    const current = workspaces.get(site.id);
    if (current) workspaces.set(site.id, { ...current, activeTerminalId: first.info.id });
  }

  const workspaceOr404 = (id: string) => workspaces.get(id) ?? fail(notFound("workspace"));
  const tabOr404 = (id: string) => tabs.get(id) ?? fail(notFound("terminal"));

  const handlers: MemoryWorkspaces["handlers"] = {
    workspace_list: () => {
      requireCore();
      return sortedWorkspaces();
    },
    workspace_active: () => {
      requireCore();
      return activeWorkspaceId ? (workspaces.get(activeWorkspaceId) ?? null) : null;
    },
    workspace_open_dialog: () => {
      requireCore();
      const next = pickQueue.length > 0 ? pickQueue.shift() : (defaultPicks.shift() ?? "another-project");
      if (next === null || next === undefined) return null;
      return openFolder(next);
    },
    workspace_activate: (args) => {
      requireCore();
      const id = requireId(args.workspaceId);
      const workspace = workspaceOr404(id);
      const alreadyActive = activeWorkspaceId === id;
      const updated = { ...workspace, lastOpenedAt: now() };
      workspaces.set(id, updated);
      activeWorkspaceId = id;
      if (!alreadyActive) emit({ type: "workspace.opened", payload: { workspaceId: id, name: workspace.name } }, id);
      return updated;
    },
    workspace_remove: (args) => {
      requireCore();
      const id = requireId(args.workspaceId);
      const workspace = workspaceOr404(id);
      if (tabsOf(id).some((t) => status(t) === "running")) {
        fail(validation("terminals_running", "Close this workspace's running terminals before removing it."));
      }
      for (const tab of tabsOf(id)) tabs.delete(tab.info.id);
      workspaces.delete(id);
      if (activeWorkspaceId === id) activeWorkspaceId = null;
      emit({ type: "workspace.removed", payload: { workspaceId: id, name: workspace.name } }, id);
      return undefined;
    },
    shells_list: () => {
      requireCore();
      return SHELLS;
    },
    terminal_list: (args) => {
      requireCore();
      const id = requireId(args.workspaceId);
      return tabsOf(id).map((t) => t.info);
    },
    terminals_running: () => {
      requireCore();
      return [...tabs.values()]
        .filter((t) => status(t) === "running")
        .map((t) => t.info)
        .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    },
    terminal_create: (args) => {
      requireCore();
      const size = requireSize(args);
      void size;
      const workspaceId = requireId(args.workspaceId);
      const shellId = args.shellId ?? null;
      if (shellId !== null) {
        if (typeof shellId !== "string") fail(rejected());
        if (!/^[A-Za-z0-9-]{1,32}$/.test(shellId)) fail(validation("invalid_shell", "Invalid shell."));
      }
      const shell = shellId === null ? SHELLS.find((s) => s.isDefault) : SHELLS.find((s) => s.id === shellId);
      if (!shell) {
        fail({
          category: "terminal",
          code: "shell_unavailable",
          message: "That shell isn't available on this computer.",
          retryable: false,
        });
      }
      const workspace = workspaceOr404(workspaceId);
      if (!workspace.available) fail(folderMissing());
      if (FREE_TERMINALS_PER_WORKSPACE !== null && tabsOf(workspaceId).length >= FREE_TERMINALS_PER_WORKSPACE) {
        fail(
          validation(
            "too_many_terminals",
            `The Free plan allows up to ${FREE_TERMINALS_PER_WORKSPACE} terminals per workspace. Close one to open another, or upgrade to MAX for unlimited terminals.`,
          ),
        );
      }
      const tab = addTab(workspace, shell.id);
      startSession(tab);
      return tab.info;
    },
    terminal_restart: (args) => {
      requireCore();
      requireSize(args);
      const tab = tabOr404(requireId(args.terminalId));
      if (status(tab) === "running") return tab.info;
      const workspace = workspaceOr404(tab.info.workspaceId);
      if (!workspace.available) fail(folderMissing());
      startSession(tab);
      return tab.info;
    },
    terminal_close: (args) => {
      requireCore();
      const tab = tabOr404(requireId(args.terminalId));
      if (status(tab) === "running") endSession(tab, 1, true);
      tabs.delete(tab.info.id);
      const workspace = workspaces.get(tab.info.workspaceId);
      if (workspace?.activeTerminalId === tab.info.id) {
        workspaces.set(workspace.id, { ...workspace, activeTerminalId: null });
      }
      return undefined;
    },
    terminal_write: (args) => {
      requireCore();
      const id = requireId(args.terminalId);
      if (typeof args.data !== "string") fail(rejected());
      if (encoder.encode(args.data).length > MAX_WRITE_BYTES) {
        fail(validation("input_too_large", "That input is too large to send to the terminal."));
      }
      const tab = tabs.get(id);
      if (!tab?.session || tab.session.exited) fail(notRunning());
      input(tab, args.data);
      return undefined;
    },
    terminal_resize: (args) => {
      requireCore();
      requireId(args.terminalId);
      requireSize(args);
      return undefined;
    },
    terminal_detach: (args) => {
      requireCore();
      const attachment = attachments.get(requireAttachmentId(args.attachmentId));
      if (!attachment) return false;
      attachment.session.listeners.delete(attachment.listener);
      attachments.delete(requireAttachmentId(args.attachmentId));
      return true;
    },
    terminal_ack: (args) => {
      requireCore();
      const id = requireAttachmentId(args.attachmentId);
      const bytes = args.bytes;
      if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0 || bytes > 0xffffffff) fail(rejected());
      return attachments.has(id);
    },
    terminal_set_active: (args) => {
      requireCore();
      const workspaceId = requireId(args.workspaceId);
      const terminalId = requireId(args.terminalId);
      const workspace = workspaces.get(workspaceId);
      const tab = tabs.get(terminalId);
      if (!workspace || tab?.info.workspaceId !== workspaceId) fail(notFound("terminal"));
      workspaces.set(workspaceId, { ...workspace, activeTerminalId: terminalId });
      return undefined;
    },
    terminal_attach: () => fail(rejected()),
  };

  /** Attachments by id (native also records the owning webview). */
  const attachments = new Map<number, { session: Session; listener: (bytes: Uint8Array) => void }>();
  let nextAttachment = 0;
  /** Mirrors Tauri's u64 deserialization of an attachment id. */
  function requireAttachmentId(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(rejected());
    return value;
  }

  return {
    handlers,
    async attachTerminal(terminalId, onOutput) {
      await Promise.resolve();
      requireCore();
      const id = requireId(terminalId);
      const tab = tabs.get(id);
      if (!tab?.session) return null;
      const session = tab.session;
      const replay = new Uint8Array(session.scrollbackBytes);
      let offset = 0;
      for (const chunk of session.scrollback) {
        replay.set(chunk, offset);
        offset += chunk.length;
      }
      onOutput(replay);
      if (!session.exited) session.listeners.add(onOutput);
      nextAttachment += 1;
      attachments.set(nextAttachment, { session, listener: onOutput });
      return nextAttachment;
    },
    queueFolders(...folders) {
      pickQueue.push(...folders);
    },
    makeUnavailable(name) {
      for (const workspace of workspaces.values()) {
        if (workspace.name === name) workspaces.set(workspace.id, { ...workspace, available: false });
      }
    },
    runningProcessCount: () => [...tabs.values()].filter((t) => t.session && !t.session.exited).length,
  };
}
