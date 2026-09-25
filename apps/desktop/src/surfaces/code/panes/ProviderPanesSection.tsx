import type { PaneInfo, ThreadSummary, Workspace } from "@kalcode/protocol";
import { Button } from "@kalcode/ui/components";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { useResolvedTheme } from "../../../shell/useResolvedTheme.ts";
import { usePermissions } from "../../permissions/PermissionsProvider.tsx";
import { PaneChannel, paneStartMode } from "./paneChannel.ts";
import { paneStatus } from "./paneLabels.ts";
import { ProviderGlyph } from "./PaneParts.tsx";
import styles from "./Panes.module.css";
import { ProviderPane } from "./ProviderPane.tsx";

interface PaneEntry {
  thread: ThreadSummary;
  info: PaneInfo;
}

/** Hook-channel changes (waiting → active or limited) carry no thread event; poll while waiting. */
const WAITING_POLL_MS = 1500;
const REFRESH_DEBOUNCE_MS = 120;

/** Whether this build offers provider panes (the `provider_panes` feature flag). */
export function useProviderPanesEnabled(): boolean {
  const { info } = useRuntime();
  return info.flags.features?.some((f) => f.id === "provider_panes" && f.visible) ?? false;
}

/**
 * The entry point for provider panes in the Code surface (Z7-W4): a strip with this workspace's
 * pane threads and "New Claude Code pane", and the selected pane. The pane system (Z7-W1) will
 * host `ProviderPane` directly; until then this section is the only place panes appear.
 */
export function ProviderPanesSection({ workspace }: { workspace: Workspace }) {
  const enabled = useProviderPanesEnabled();
  if (!enabled || !workspace.available) return null;
  return <PanesStrip workspace={workspace} />;
}

function PanesStrip({ workspace }: { workspace: Workspace }) {
  const { client } = useRuntime();
  const { events } = useEvents();
  const { settings } = usePermissions();
  const theme = useResolvedTheme();
  const channel = useMemo(() => new PaneChannel(client), [client]);
  const [panes, setPanes] = useState<PaneEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const threads = await client.listThreads({ workspaceId: workspace.id });
      const candidates = threads.filter((t) => t.providerId === "claude-code");
      const infos = await Promise.all(candidates.map((t) => channel.info(t.id).catch(() => null)));
      if (current !== generation.current) return;
      const next: PaneEntry[] = [];
      candidates.forEach((thread, i) => {
        const info = infos[i];
        if (info) next.push({ thread, info });
      });
      next.sort((a, b) => a.thread.createdAt.localeCompare(b.thread.createdAt));
      setPanes(next);
    } catch (cause) {
      if (current === generation.current) setError(toKalCodeError(cause).message);
    }
  }, [client, channel, workspace.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Thread and approval events for this workspace (or its panes) refresh the strip: status,
  // names, approvals. Each event is looked at once; refreshes are coalesced.
  const lastEvent = events[0];
  const handledSeq = useRef(0);
  const paneIds = useRef(new Set<string>());
  paneIds.current = new Set(panes.map((p) => p.thread.id));
  const scheduled = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!lastEvent || lastEvent.seq <= handledSeq.current) return;
    handledSeq.current = lastEvent.seq;
    const threadId = lastEvent.correlation.threadId;
    const related =
      lastEvent.correlation.workspaceId === workspace.id || (threadId !== null && paneIds.current.has(threadId));
    if (!related || scheduled.current) return;
    scheduled.current = setTimeout(() => {
      scheduled.current = null;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }, [lastEvent, refresh, workspace.id]);
  useEffect(
    () => () => {
      if (scheduled.current) clearTimeout(scheduled.current);
    },
    [],
  );

  const waiting = panes.some((p) => p.info.hookChannel === "waiting");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refresh(), WAITING_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  const current = panes.find((p) => p.thread.id === selected) ?? null;

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const thread = await channel.create({
        workspaceId: workspace.id,
        permissionMode: paneStartMode(settings?.defaultMode),
      });
      setSelected(thread.id);
      await refresh();
      setFocusRequest((n) => n + 1);
    } catch (cause) {
      setError(toKalCodeError(cause).message);
    } finally {
      setCreating(false);
    }
  };

  const updated = (thread: ThreadSummary) => {
    setPanes((list) => list.map((p) => (p.thread.id === thread.id ? { ...p, thread } : p)));
    void refresh();
  };

  return (
    <section className={styles.section} aria-label="Provider panes" data-open={current ? "true" : "false"}>
      <div className={styles.strip}>
        <span className={styles.stripLabel}>Provider panes</span>
        {panes.length > 0 ? (
          <div className={styles.paneTabs} role="tablist" aria-label="Provider panes in this workspace">
            {panes.map(({ thread }) => {
              const active = thread.id === current?.thread.id;
              return (
                <button
                  key={thread.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={styles.paneTab}
                  onClick={() => {
                    setSelected(active ? null : thread.id);
                    if (!active) setFocusRequest((n) => n + 1);
                  }}
                >
                  <ProviderGlyph providerId={thread.providerId} providerName={thread.providerName} />
                  <span className={styles.paneTabName}>{thread.name}</span>
                  <span className={styles.qualifier}>{paneStatus(thread.status).label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <span className={styles.stripNote}>Run Claude Code in a pane: its own terminal, checked by KalCode.</span>
        )}
        {error ? (
          <span className={styles.stripNote} role="alert">
            {error}
          </span>
        ) : null}
        <Button size="sm" icon={<Plus />} busy={creating} onClick={() => void create()}>
          New Claude Code pane
        </Button>
      </div>
      {current ? (
        <ProviderPane
          key={current.thread.id}
          thread={current.thread}
          info={current.info}
          channel={channel}
          theme={theme}
          focusRequest={focusRequest}
          onChanged={updated}
        />
      ) : null}
    </section>
  );
}
