import type {
  DevelopmentService,
  FileHandle,
  FileRef,
  OperationRecord,
  ProviderAccount,
  ThreadSummary,
  Workspace,
} from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KalCodeClient } from "../../ipc/client.ts";
import { toKalCodeError } from "../../ipc/errors.ts";
import { type OperationsApi, OperationsClient } from "../../ipc/operations.ts";
import { focusOperationsTarget } from "../../kalvoice/sceneOperations.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { openProviderAccounts } from "../../surfaces/providers/providersTab.ts";
import { useThreadsIntent } from "../../surfaces/threads/intent.tsx";
import { type Destination, useNavigation, viewVisible } from "../navigation.tsx";
import { dispatchPaneCommand } from "../panes/paneCommands.ts";
import { useOptionalSearchActions } from "../rail/search/SearchProvider.tsx";
import { FAVORITE_COMMANDS } from "./commands.ts";
import { type FavoriteEntry, type FavoriteTarget, normalizeFavoriteTarget } from "./model.ts";

export interface FavoriteOpenResult {
  opened: boolean;
  reason?: string;
}
interface ResolvedFavorite {
  target: FavoriteTarget;
  workspace?: Workspace;
  thread?: ThreadSummary;
  file?: FileRef;
  account?: ProviderAccount;
  run?: OperationRecord;
  service?: DevelopmentService;
  commandLabel?: string;
}

async function findFile(client: KalCodeClient, workspaceId: string, path: string): Promise<FileRef> {
  const segments = path.split("/");
  let directory: FileHandle | null = null;
  for (let depth = 0; depth < segments.length; depth += 1) {
    const prefix = segments.slice(0, depth + 1).join("/");
    let cursor: string | null = null;
    const cursors = new Set<string>();
    let found = false;
    do {
      const page = await client.listFiles(workspaceId, directory, 200, cursor);
      const entry = page.items.find((item) => item.file.displayPath.replaceAll("\\", "/") === prefix);
      if (entry) {
        if (depth === segments.length - 1 && !entry.isDir) return entry.file;
        if (!entry.isDir) break;
        directory = entry.file.handle;
        found = true;
        break;
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor))
        throw new Error("The folder listing changed. Try opening this favorite again.");
      if (cursor) cursors.add(cursor);
      if (cursors.size > 250) throw new Error("This folder is too large to check here. Find the file in Project.");
    } while (cursor);
    if (!found) break;
  }
  throw new Error(
    "This file is missing or no longer accessible. Find its new location in Project, or remove this favorite.",
  );
}

/** Read-only resolution: never creates, resumes or restarts the saved destination. */
export async function resolveFavorite(
  client: KalCodeClient,
  operations: Pick<OperationsApi, "detail" | "snapshot">,
  value: FavoriteTarget,
  activeWorkspaceId: string | null = null,
): Promise<ResolvedFavorite> {
  const target = normalizeFavoriteTarget(value);
  if (!target) throw new Error("This saved destination is invalid. Remove it and save the current destination again.");
  const result: ResolvedFavorite = { target };
  let workspaceId = target.workspaceId;
  if (target.kind === "workspace") workspaceId = target.id;
  if (target.kind === "thread" || target.kind === "agent") {
    result.thread = await client.getThread(target.id);
    if (result.thread.archivedAt)
      throw new Error("This session is archived. Restore it in Threads, or remove this favorite.");
    workspaceId = result.thread.workspaceId;
  }
  if (target.kind === "command") {
    result.commandLabel = FAVORITE_COMMANDS[target.id];
    if (!result.commandLabel)
      throw new Error("This command is no longer available. Remove this favorite and choose another command.");
    return result;
  }
  if (target.kind === "account") {
    result.account = (await client.listProviderAccounts()).find(
      (account) => account.id === target.id && !account.archivedAt,
    );
    if (!result.account)
      throw new Error("This account was removed. Choose an account in Providers, or remove this favorite.");
    return result;
  }
  if (target.kind === "run") {
    result.run = (await operations.detail(target.id)).run;
    workspaceId = result.run.spec.workspaceId;
  }
  if (target.kind === "service") {
    result.service = (await operations.snapshot()).services.find((service) => service.id === target.id);
    if (!result.service)
      throw new Error("This service is no longer listed. Check Services in Operations, or remove this favorite.");
    workspaceId = result.service.workspaceId;
  }
  if (target.kind === "browser") workspaceId ??= activeWorkspaceId;
  if (!workspaceId && result.thread && result.thread.runtimeKind !== "interactive_pty") return result;
  if (!workspaceId) throw new Error("Open a workspace before opening this favorite.");
  result.workspace = (await client.listWorkspaces()).find((workspace) => workspace.id === workspaceId);
  if (!result.workspace) throw new Error("This workspace was removed. Reopen its folder, or remove this favorite.");
  if (!result.workspace.available)
    throw new Error("This workspace folder is unavailable. Reconnect it, then try again.");
  if (
    target.kind === "terminal" &&
    !(await client.listTerminals(workspaceId)).some((terminal) => terminal.id === target.id)
  ) {
    throw new Error("This terminal was closed. Open an existing terminal in Code, or remove this favorite.");
  }
  if (target.kind === "file") result.file = await findFile(client, workspaceId, target.id);
  return result;
}

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : toKalCodeError(cause).message);

export function useFavoriteResolver() {
  const { client, info } = useRuntime();
  const workspaces = useWorkspaces();
  const navigation = useNavigation();
  const threads = useThreadsIntent();
  const search = useOptionalSearchActions();
  const operations = useMemo(
    () => new OperationsClient((command, args) => client.transport.invoke(command, args)),
    [client],
  );
  const [preview, setPreview] = useState<FileRef | null>(null);
  const pendingFocus = useRef<AbortController | null>(null);
  const lifetime = useMemo(() => ({ client, mounted: false, request: 0 }), [client]);
  const live = useRef({ lifetime, workspaces, navigation, threads, search });
  live.current = { lifetime, workspaces, navigation, threads, search };
  useEffect(() => {
    lifetime.mounted = true;
    setPreview(null);
    return () => {
      lifetime.mounted = false;
      lifetime.request += 1;
      pendingFocus.current?.abort();
    };
  }, [lifetime]);
  const resolve = useCallback(
    async (target: FavoriteTarget) => {
      const resolved = await resolveFavorite(client, operations, target, live.current.workspaces.active?.id ?? null);
      let destination: Destination = "code";
      if (resolved.thread && resolved.thread.runtimeKind !== "interactive_pty") destination = "threads";
      if (target.kind === "account") destination = "providers";
      if (target.kind === "run" || target.kind === "service") destination = "operations";
      if (
        target.kind !== "command" &&
        target.kind !== "file" &&
        !info.flags.surfaces.some(
          (surface) => surface.id === destination && surface.visible && surface.state === "available",
        )
      ) {
        throw new Error("This destination is unavailable in this app. Keep the favorite and try again after updating.");
      }
      if (target.kind === "command") {
        if (!live.current.search) throw new Error("The command palette isn't available here.");
        const surfaceAvailable = (id: string) =>
          info.flags.surfaces.some((surface) => surface.id === id && surface.visible && surface.state === "available");
        const commandDestination = target.id.startsWith("navigate:")
          ? target.id.slice("navigate:".length)
          : target.id.startsWith("thread:")
            ? "threads"
            : "code";
        const available =
          commandDestination === "home" || commandDestination === "folder"
            ? viewVisible(commandDestination, info.flags.features)
            : surfaceAvailable(commandDestination);
        if (!available)
          throw new Error("This command isn't available in this app. Keep the favorite and try again after updating.");
        if (target.id === "terminal:new") {
          const active = live.current.workspaces.active;
          if (!active?.available) throw new Error("Open an available workspace before choosing New terminal.");
          const workspace = (await client.listWorkspaces()).find((item) => item.id === active.id);
          if (!workspace?.available)
            throw new Error("Reconnect the active workspace folder before choosing New terminal.");
        }
      }
      return resolved;
    },
    [client, info.flags.surfaces, info.flags.features, operations],
  );
  const check = useCallback(
    async (target: FavoriteTarget): Promise<string | null> => {
      try {
        await resolve(target);
        return null;
      } catch (cause) {
        return reasonOf(cause);
      }
    },
    [resolve],
  );
  const open = useCallback(
    async (entry: FavoriteEntry): Promise<FavoriteOpenResult> => {
      pendingFocus.current?.abort();
      const abort = new AbortController();
      pendingFocus.current = abort;
      const request = ++lifetime.request;
      const current = () => live.current.lifetime === lifetime && lifetime.mounted && lifetime.request === request;
      const cancelled: FavoriteOpenResult = {
        opened: false,
        reason: "Another navigation replaced this request. Try again.",
      };
      if (!current()) return cancelled;
      try {
        const resolved = await resolve(entry.target);
        if (!current()) return cancelled;
        const { target, workspace, thread, file, account, run, service, commandLabel } = resolved;
        if (target.kind === "command") {
          if (!live.current.search || !commandLabel)
            return { opened: false, reason: "The command palette isn't available here." };
          live.current.search.openWith(commandLabel);
          return { opened: true };
        }
        if (account) {
          openProviderAccounts({ providerId: account.providerId, accountId: account.id });
          live.current.navigation.navigate("providers");
          return { opened: true };
        }
        if (!workspace && thread && thread.runtimeKind !== "interactive_pty") {
          live.current.navigation.navigate("threads");
          live.current.threads.request("open", thread.id);
          return { opened: true };
        }
        if (!workspace) return { opened: false, reason: "Choose an available workspace first." };
        if (!(await live.current.workspaces.activate(workspace.id)))
          return { opened: false, reason: "This workspace couldn't be opened. Reconnect its folder and try again." };
        if (!current()) return cancelled;
        if (target.kind === "terminal" || thread?.runtimeKind === "interactive_pty") {
          live.current.navigation.navigate("code");
          const result = dispatchPaneCommand(
            {
              kind: "open",
              content: thread ? { kind: "agent", agentId: thread.id } : { kind: "terminal", terminalId: target.id },
            },
            { queue: true, scope: workspace.id },
          );
          return current()
            ? {
                opened: result.handled,
                ...(result.handled ? {} : { reason: result.message || "This pane couldn't be opened. Try again." }),
              }
            : cancelled;
        }
        if (thread) {
          live.current.navigation.navigate("threads");
          live.current.threads.request("open", thread.id);
        } else if (file) {
          setPreview(file);
        } else if (run || service) {
          live.current.navigation.navigate("operations");
          const focused = await focusOperationsTarget(
            run
              ? { kind: "run", tab: "runs", runId: run.id, workspaceId: workspace.id, label: run.spec.name }
              : {
                  kind: "service",
                  tab: "services",
                  serviceId: service?.id ?? target.id,
                  workspaceId: workspace.id,
                  label: service?.name ?? entry.title,
                },
            { signal: abort.signal },
          );
          return current()
            ? { opened: focused, ...(focused ? {} : { reason: "Operations couldn't focus this item. Try again." }) }
            : cancelled;
        } else {
          live.current.navigation.navigate("code");
          if (target.kind === "browser") {
            // A dedicated browser keeps this exact query/fragment. The general opener
            // deduplicates by its query-free persisted address and can focus another page.
            const result = dispatchPaneCommand(
              { kind: "browser-control", command: { kind: "open", url: target.id, newPane: true } },
              { queue: true, scope: workspace.id },
            );
            return {
              opened: result.handled,
              ...(result.handled ? {} : { reason: result.message || "Browser couldn't open. Try again." }),
            };
          }
        }
        return { opened: true };
      } catch (cause) {
        return current() ? { opened: false, reason: reasonOf(cause) } : cancelled;
      }
    },
    [lifetime, resolve],
  );
  const closePreview = useCallback(() => setPreview(null), []);
  return { open, check, preview, closePreview };
}

export function useOpenFavorite() {
  return useFavoriteResolver().open;
}
