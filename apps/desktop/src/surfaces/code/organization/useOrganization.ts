/**
 * Terminal Organization's live inputs for one workspace: the related-process scan (polled while
 * Code is shown, the window is visible and a terminal runs), the workspace's Operations snapshot
 * and Git summary from the shared deck feeds, pending approvals, and the agents' persisted titles.
 * Everything it reports comes from those observations; a missing or partial scan means no
 * terminal badge rather than a guess.
 */
import type { OperationsSnapshot, ShellOption, TerminalInfo } from "@kalcode/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ProcessInfo, UtilityClient } from "../../../ipc/utilities.ts";
import { useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { tabLabels } from "../../../runtime/workspaceState.ts";
import { useOptionalDeckData } from "../../../shell/deck/DeckData.tsx";
import { needsYouCount } from "../../../shell/deck/deckModel.ts";
import { contentKey } from "../../../shell/panes/model.ts";
import { filteredSnapshot } from "../../operations/model.ts";
import { useOptionalPermissions } from "../../permissions/PermissionsProvider.tsx";
import { PROCESS_SCAN_LIMIT } from "../kaltidy/classify.ts";
import type { ProviderPaneEntry } from "../panes/useProviderPanes.ts";
import {
  agentBadge,
  agentDisplayName,
  type HappeningSegment,
  happening,
  isCustomTerminalTitle,
  numberRepeats,
  type OrgItem,
  scanTerminals,
  type TerminalProcesses,
  terminalBadge,
  terminalPurpose,
} from "./model.ts";
import { type OrgPrefsApi, useOrgPrefs } from "./prefs.ts";

/** How often the process scan refreshes while Code is shown and a terminal runs. */
export const PROCESS_SCAN_MS = 5000;

export interface Organization {
  items: OrgItem[];
  byKey: ReadonlyMap<string, OrgItem>;
  segments: HappeningSegment[];
  /** Waiting agents first, then approvals with no agent in this workspace. */
  needsYou: { count: number; firstAgentKey: string | null };
  /** The workspace's Operations snapshot, or null while unavailable. */
  operations: OperationsSnapshot | null;
  prefs: OrgPrefsApi;
}

interface Inputs {
  workspaceId: string;
  terminals: readonly TerminalInfo[];
  shells: readonly ShellOption[];
  panes: readonly ProviderPaneEntry[];
  /** Code is the shown page. */
  active: boolean;
}

/** A related-process scan and when it was sampled. */
export interface ProcessScan {
  processes: ProcessInfo[];
  /** Epoch ms of the sample; terminals started after it aren't in it. */
  sampledAt: number;
}

/**
 * Polls the related-process scan while it can matter, and rescans at once when the set of running
 * terminals changes; null when unavailable or cut short.
 */
function useProcessScan(enabled: boolean, runningKey: string): ProcessScan | null {
  const { client } = useRuntime();
  const utilities = useMemo(
    () => new UtilityClient((command, args) => client.transport.invoke(command, args)),
    [client],
  );
  const [scan, setScan] = useState<ProcessScan | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new set of running terminals restarts the loop (an immediate rescan).
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const list = await utilities.processes("related");
          const sampledAt = Date.parse(list.sampledAt);
          if (!cancelled) {
            setScan(
              list.processes.length >= PROCESS_SCAN_LIMIT || Number.isNaN(sampledAt)
                ? null
                : { processes: list.processes, sampledAt },
            );
          }
        } catch {
          if (!cancelled) setScan(null);
        }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), PROCESS_SCAN_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, utilities, runningKey]);
  return enabled ? scan : null;
}

const pad = (n: number) => String(n).padStart(6, "0");

export function useOrganization({ workspaceId, terminals, shells, panes, active }: Inputs): Organization {
  const prefs = useOrgPrefs(workspaceId);
  const deck = useOptionalDeckData();
  const permissions = useOptionalPermissions();
  const runningKey = terminals
    .filter((t) => t.status === "running")
    .map((t) => `${t.id}@${t.startedAt ?? ""}`)
    .join(",");
  const processScan = useProcessScan(active && runningKey !== "", runningKey);

  const globalOperations = deck?.operations.data ?? null;
  const operations = useMemo(
    () => (globalOperations ? filteredSnapshot(globalOperations, workspaceId) : null),
    [globalOperations, workspaceId],
  );
  // A scan every few seconds usually observes the same thing: keep the previous result then, so
  // the toolbar and status bar don't re-render for an unchanged workspace.
  const lastScan = useRef<{ json: string; value: Map<string, TerminalProcesses> | null } | null>(null);
  const scan = useMemo(() => {
    const value = scanTerminals(terminals, processScan?.processes ?? null, processScan?.sampledAt);
    const json = JSON.stringify(value ? [...value] : null);
    if (lastScan.current?.json === json) return lastScan.current.value;
    lastScan.current = { json, value };
    return value;
  }, [terminals, processScan]);

  const items = useMemo(() => {
    const labels = tabLabels(terminals);
    const purposes = new Map(terminals.map((t) => [t.id, terminalPurpose(t, operations)]));
    const purposeNames = numberRepeats(
      terminals.flatMap((t) => {
        const name = purposes.get(t.id)?.name;
        return name && !isCustomTerminalTitle(t, shells) ? [[t.id, name] as const] : [];
      }),
    );
    const result: OrgItem[] = terminals.map((terminal) => {
      const content = { kind: "terminal", terminalId: terminal.id } as const;
      return {
        key: contentKey(content),
        content,
        kind: "terminal",
        title: purposeNames.get(terminal.id) ?? labels.get(terminal.id) ?? terminal.title,
        status: terminalBadge(terminal, scan?.get(terminal.id) ?? null, operations),
        group: purposes.get(terminal.id)?.group ?? "Terminals",
        glyph: "shell",
        order: `0:${pad(terminal.position)}`,
      };
    });
    for (const { thread, info } of panes) {
      if (thread.archivedAt !== null) continue;
      const content = { kind: "agent", agentId: thread.id } as const;
      result.push({
        key: contentKey(content),
        content,
        kind: "agent",
        title: agentDisplayName(thread),
        status: agentBadge(thread, info),
        group: "Agents",
        glyph: thread.providerId,
        order: `1:${thread.createdAt}`,
      });
    }
    return result;
  }, [terminals, shells, panes, operations, scan]);

  const byKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);

  const pending = permissions?.pending;
  const needsYou = useMemo(() => {
    const waiting = panes.filter(
      ({ thread }) =>
        thread.archivedAt === null &&
        byKey.get(contentKey({ kind: "agent", agentId: thread.id }))?.status?.badge === "needs_you",
    );
    const approvals = (pending ?? []).filter((a) => a.action.workspaceId === workspaceId);
    const first = waiting[0];
    return {
      count: needsYouCount(
        waiting.map((p) => p.thread),
        approvals,
      ),
      firstAgentKey: first ? contentKey({ kind: "agent", agentId: first.thread.id }) : null,
    };
  }, [panes, byKey, pending, workspaceId]);

  const git = deck?.git.data ?? null;
  const segments = useMemo(
    () =>
      happening({
        agents: items.filter((item) => item.kind === "agent"),
        needsYou: needsYou.count,
        operations,
        git: git ? { branch: git.branch, changed: git.changed, untracked: git.untracked } : null,
      }),
    [items, needsYou.count, operations, git],
  );

  return useMemo(
    () => ({ items, byKey, segments, needsYou, operations, prefs }),
    [items, byKey, segments, needsYou, operations, prefs],
  );
}
