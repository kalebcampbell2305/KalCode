import type {
  FileHandle,
  FileRef,
  LocatorEntityKind,
  ProviderAccount,
  ProviderStatus,
  ThreadSummary,
} from "@kalcode/protocol";
import { useEffect, useMemo, useState } from "react";
import { useEvents, useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../../runtime/WorkspaceProvider.tsx";
import { isCodingAgent } from "../../../surfaces/dashboard/data/agents.ts";
import { accountInlineLabel, accountSignIn } from "../../../surfaces/providers/accountIdentity.ts";
import { useOptionalRail } from "../RailProvider.tsx";
import { QuickSearchIndex, type SearchDocument } from "./quickSearchIndex.ts";

export type QuickTarget =
  | { kind: "thread" | "agent"; thread: ThreadSummary }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "terminal"; terminalId: string; workspaceId: string }
  | { kind: "provider"; providerId: string }
  | { kind: "account"; account: ProviderAccount }
  | { kind: "file"; file: FileRef }
  | { kind: "setting" | "release"; section: string };

const SETTINGS = [
  ["appearance", "Appearance", "theme dark light density motion animations sidebar"],
  ["kalcode-account", "KalCode account", "billing plan subscription sign in"],
  ["kalvoice", "KalVoice", "voice microphone push to talk hotkey speech dictation"],
  ["resources", "Resource limits", "cpu memory ram concurrency performance"],
  ["doctor", "Environment Doctor", "repair environment tools path setup"],
  ["updates", "Updates", "update channel stable beta version"],
  ["diagnostics", "Diagnostics", "logs report errors credential store"],
  ["about", "About KalCode", "version platform build"],
  ["permissions", "Permissions", "bypass plan defaults security"],
  ["integrations", "Integrations", "editor external app terminal browser"],
] as const;

/** Kept warm while the palette is closed; slow IPC never gates the dialog opening. */
export function useQuickSwitcher(open: boolean, query: string, kinds: readonly LocatorEntityKind[] = []) {
  const { client, info } = useRuntime();
  const workspaces = useWorkspaces();
  const rail = useOptionalRail()?.rail ?? null;
  // The name the person gave a workspace in the rail is the name they search for.
  const railNames = useMemo(() => {
    const names = new Map<string, string>();
    if (!rail) return names;
    for (const entry of [...rail.pinned, ...rail.recent, ...rail.groups.flatMap((g) => g.workspaces), ...rail.archived])
      names.set(entry.workspaceId, entry.name);
    return names;
  }, [rail]);
  const { events } = useEvents();
  const [metadata, setMetadata] = useState<{
    client: typeof client;
    accounts: ProviderAccount[];
    threads: ThreadSummary[];
    providers: ProviderStatus[];
  }>({ client, accounts: [], threads: [], providers: [] });
  const [availableRelease, setAvailableRelease] = useState<{ client: typeof client; version: string } | null>(null);
  const [recent] = useState(() => new Map<string, number>());
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let live = true;
    setMetadata((old) => (old.client === client ? old : { client, accounts: [], threads: [], providers: [] }));
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      setRefreshing(true);
      await Promise.allSettled([
        client.updaterStatus().then((status) => {
          if (live) setAvailableRelease(status.availableVersion ? { client, version: status.availableVersion } : null);
        }),
        client.listProviderAccounts().then((accounts) => {
          if (live)
            setMetadata((old) => ({
              ...old,
              client,
              accounts: accounts.filter((account) => account.archivedAt === null),
            }));
        }),
        client.listThreads({ includeArchived: false }).then((threads) => {
          if (live)
            setMetadata((old) => ({ ...old, client, threads: threads.filter((thread) => thread.archivedAt === null) }));
        }),
        client.listProviders().then((providers) => {
          if (live) setMetadata((old) => ({ ...old, client, providers }));
        }),
      ]);
      if (!live) return;
      setRefreshing(false);
      pending = false;
    };
    void refresh();
    const timer = open ? setInterval(() => void refresh(), 30000) : undefined;
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, open]);
  const accounts = metadata.client === client ? metadata.accounts : [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: native handles are scoped to the runtime client.
  const fileCaches = useMemo(
    () => new Map<string, { index: QuickSearchIndex<QuickTarget>; refreshedAt: number; eventSeq: number }>(),
    [client],
  );
  const [indexing, setIndexing] = useState(false);
  const workspaceId = workspaces.active?.available ? workspaces.active.id : null;
  const workspaceName = workspaces.active?.name ?? "";
  const fileEventSeq =
    events.find((event) => event.type.startsWith("file.") && event.correlation.workspaceId === workspaceId)?.seq ?? 0;
  const [fileRefresh, setFileRefresh] = useState(0);
  useEffect(() => {
    if (open) setFileRefresh((n) => n + 1);
  }, [open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fileRefresh schedules a throttled refresh on opening.
  useEffect(() => {
    if (!workspaceId) {
      setIndexing(false);
      return;
    }
    const previous = fileCaches.get(workspaceId);
    if (previous && previous.refreshedAt > Date.now() - 30000 && previous.eventSeq >= fileEventSeq) {
      setIndexing(false);
      return;
    }
    let live = true;
    const scan = async () => {
      setIndexing(true);
      const nextIndex = new QuickSearchIndex<QuickTarget>();
      if (!previous) fileCaches.set(workspaceId, { index: nextIndex, refreshedAt: 0, eventSeq: fileEventSeq });
      const queue: { dir: FileHandle | null; cursor: string | null }[] = [{ dir: null, cursor: null }];
      const seen = new Set<string>();
      for (let offset = 0; live && offset < queue.length; offset++) {
        const task = queue[offset];
        if (!task) continue;
        try {
          const page = await client.listFiles(workspaceId, task.dir, 200, task.cursor);
          if (!live) return;
          for (const entry of page.items) {
            if (entry.ignored || /(^|\/)(\.git|node_modules|target|dist|\.next)(\/|$)/.test(entry.file.displayPath))
              continue;
            if (entry.isDir) {
              if (!seen.has(entry.file.handle.id)) {
                seen.add(entry.file.handle.id);
                queue.push({ dir: entry.file.handle, cursor: null });
              }
            } else {
              nextIndex.add({
                id: `file:${workspaceId}:${entry.file.displayPath}`,
                kind: "File",
                label: entry.file.displayPath.split("/").pop() ?? entry.file.displayPath,
                metadata: `${workspaceName} · ${entry.file.displayPath}`,
                workspaceId,
                target: { kind: "file", file: entry.file },
              });
            }
          }
          if (page.nextCursor && page.nextCursor !== task.cursor)
            queue.push({ dir: task.dir, cursor: page.nextCursor });
          setRevision((n) => n + 1);
          // Yield between directory pages, including in-memory/test transports.
          await new Promise((resolve) => setTimeout(resolve, 8));
        } catch {
          if (!live) return;
          if (task.dir === null) {
            setIndexing(false);
            return;
          }
          /* A removed or inaccessible directory does not discard other results. */
        }
      }
      if (live) {
        fileCaches.set(workspaceId, { index: nextIndex, refreshedAt: Date.now(), eventSeq: fileEventSeq });
        while (fileCaches.size > 8) {
          const oldest = fileCaches.keys().next().value;
          if (oldest) fileCaches.delete(oldest);
        }
        setRevision((n) => n + 1);
        setIndexing(false);
      }
    };
    void scan();
    return () => {
      live = false;
    };
  }, [client, fileCaches, workspaceId, workspaceName, fileEventSeq, fileRefresh]);

  const index = useMemo(() => {
    const next = new QuickSearchIndex<QuickTarget>();
    const add = (document: SearchDocument<QuickTarget>) => next.add(document);
    for (const workspace of workspaces.workspaces) {
      const railName = railNames.get(workspace.id);
      if (workspace.available)
        add({
          id: `workspace:${workspace.id}`,
          kind: "Workspace",
          label: railName ?? workspace.name,
          metadata: workspace.displayPath,
          keywords: `switch to workspace project folder${railName && railName !== workspace.name ? ` ${workspace.name}` : ""}`,
          workspaceId: workspace.id,
          target: { kind: "workspace", workspaceId: workspace.id },
        });
    }
    const terminals = new Map(
      [...workspaces.running, ...workspaces.terminals].map((terminal) => [terminal.id, terminal]),
    );
    for (const terminal of terminals.values()) {
      const workspace = workspaces.workspaces.find((item) => item.id === terminal.workspaceId);
      add({
        id: `terminal:${terminal.id}`,
        kind: "Terminal",
        label: terminal.title,
        metadata: `${workspace?.name ?? "Workspace"} · ${terminal.shellId} · ${terminal.status}`,
        workspaceId: terminal.workspaceId,
        target: { kind: "terminal", terminalId: terminal.id, workspaceId: terminal.workspaceId },
      });
    }
    if (metadata.client === client) {
      for (const thread of metadata.threads) {
        const agent = isCodingAgent(thread);
        if (!agent && !info.flags.surfaces.some((surface) => surface.id === "threads" && surface.visible)) continue;
        add({
          id: `${agent ? "agent" : "thread"}:${thread.id}`,
          kind: agent ? "Coding agent" : "Thread",
          label: thread.name,
          metadata: `${thread.providerName} · ${thread.accountLabel ?? "Default account"} · ${thread.workspaceName}`,
          workspaceId: thread.workspaceId,
          keywords: `${thread.status} ${thread.currentActivity ?? ""}`,
          target: { kind: agent ? "agent" : "thread", thread },
        });
      }
      for (const provider of metadata.providers)
        add({
          id: `provider:${provider.id}`,
          kind: "Provider",
          label: provider.displayName,
          metadata: "Provider setup and connection",
          target: { kind: "provider", providerId: provider.id },
        });
      for (const account of metadata.accounts)
        add({
          id: `account:${account.id}`,
          kind: "Account",
          label: accountInlineLabel(account),
          metadata: accountSignIn(account).label,
          target: { kind: "account", account },
        });
    }
    for (const [section, label, keywords] of SETTINGS) {
      const feature =
        section === "resources" ? "resource_governor" : section === "doctor" ? "environment_doctor" : null;
      if (
        feature &&
        !info.flags.features.some((flag) => flag.id === feature && flag.visible && flag.state === "available")
      )
        continue;
      add({
        id: `setting:${section}`,
        kind: "Setting",
        label,
        metadata: "Settings",
        keywords,
        target: { kind: "setting", section },
      });
    }
    add({
      id: "release:current",
      kind: "Release",
      label: `KalCode ${info.version}`,
      metadata: "Releases · installed version and updates",
      keywords: "release notes changelog downloads updates",
      target: { kind: "release", section: "updates" },
    });
    if (availableRelease?.client === client && availableRelease.version !== info.version) {
      add({
        id: "release:available",
        kind: "Release",
        label: `KalCode ${availableRelease.version}`,
        metadata: "Available update",
        keywords: "release downloads update",
        target: { kind: "release", section: "updates" },
      });
    }
    return next;
  }, [
    client,
    metadata,
    info,
    availableRelease,
    workspaces.workspaces,
    workspaces.terminals,
    workspaces.running,
    railNames,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision publishes incremental file indexing and recency updates.
  const results = useMemo(() => {
    const accepts = (item: SearchDocument<QuickTarget>) =>
      kinds.length === 0 ||
      kinds.includes((item.target.kind === "account" ? "provider" : item.target.kind) as LocatorEntityKind);
    const combined = new QuickSearchIndex<QuickTarget>();
    for (const document of [
      ...index.search(query, workspaceId, recent, 24, accepts),
      ...(query.trim()
        ? [...fileCaches.values()].flatMap((cache) => cache.index.search(query, workspaceId, recent, 24, accepts))
        : []),
    ])
      combined.add(document);
    return combined.search(query, workspaceId, recent);
  }, [index, fileCaches, query, workspaceId, recent, revision, kinds]);
  const remember = (id: string) => {
    recent.delete(id);
    recent.set(id, Date.now());
    if (recent.size > 200) recent.delete(recent.keys().next().value ?? "");
    setRevision((n) => n + 1);
  };
  return { results, accounts, refreshing: refreshing || indexing, remember };
}
