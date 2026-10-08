import { Tooltip } from "@kalcode/ui/components";
import { useMemo } from "react";
import { type Ownership, ownersOf } from "../../runtime/ownership/model.ts";
import { useOptionalOwnership } from "../dashboard/data/DashboardData.tsx";
import styles from "./Folder.module.css";

export type OwnerTone = "working" | "received" | "area" | "shared";

export interface OwnerView {
  tone: OwnerTone;
  /** One line per owner, for the tooltip. */
  lines: string[];
  /** The same words for assistive technology. */
  label: string;
}

export interface OwnerLookup {
  /** Who holds this file, or null. */
  file(path: string): OwnerView | null;
  /** A direct child file of this folder is held, or null. */
  folder(path: string): OwnerView | null;
}

const MAX_LINES = 3;
const parentOf = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};
const clean = (path: string) => path.replaceAll("\\", "/").replace(/^\.\//, "");

function holdsAnything(ownership: Ownership, workspaceId: string): boolean {
  for (const claim of ownership.claims.values()) {
    if (claim.workspaceId !== workspaceId) continue;
    if (claim.files.length > 0 || claim.areas.length > 0 || (claim.received?.files.length ?? 0) > 0) return true;
  }
  return false;
}

/**
 * File ownership for the file views, computed once per ownership change and then looked up per
 * visible row. Null (and no work per row) while nobody holds anything in this project.
 */
export function useOwnerLookup(workspaceId: string): OwnerLookup | null {
  const ownership = useOptionalOwnership();
  return useMemo(() => {
    if (!ownership || !holdsAnything(ownership, workspaceId)) return null;
    const nameOf = (id: string) => ownership.claims.get(id)?.name ?? "Another agent";
    const fullName = (id: string) => {
      const claim = ownership.claims.get(id);
      if (!claim) return "Another agent";
      return claim.name === claim.providerName ? claim.name : `${claim.providerName} · ${claim.name}`;
    };
    // Truthful about where and when: a worktree agent changes its own copy; an ended agent's
    // changes are unmerged, not being edited.
    const editingLine = (id: string) => {
      const claim = ownership.claims.get(id);
      if (claim && !claim.active) return `${fullName(id)} has unmerged changes to this file`;
      if (claim?.worktreeId) return `${fullName(id)} is changing this file in its own worktree`;
      return `${fullName(id)} is editing this file`;
    };
    const cache = new Map<string, OwnerView | null>();
    const file = (raw: string): OwnerView | null => {
      const path = clean(raw);
      if (cache.has(path)) return cache.get(path) ?? null;
      const owners = ownersOf(ownership, workspaceId, path);
      let view: OwnerView | null = null;
      const first = owners[0];
      if (first) {
        const editing = owners.filter((o) => o.how === "editing").length;
        const lines = owners
          .slice(0, MAX_LINES)
          .map((o) =>
            o.how === "editing"
              ? editingLine(o.agentId)
              : o.how === "received"
                ? `${nameOf(o.agentId)} received this file in a handoff`
                : `In ${nameOf(o.agentId)}'s area`,
          );
        if (owners.length > MAX_LINES) lines.push(`and ${owners.length - MAX_LINES} more`);
        view = {
          tone:
            editing > 1
              ? "shared"
              : first.how === "editing"
                ? "working"
                : first.how === "received"
                  ? "received"
                  : "area",
          lines,
          label: lines.join("; "),
        };
      }
      cache.set(path, view);
      return view;
    };
    // Folders: which directories directly contain a held file, and who holds it.
    const inFolder = new Map<string, Set<string>>();
    for (const claim of ownership.claims.values()) {
      if (claim.workspaceId !== workspaceId) continue;
      for (const path of [...claim.files, ...(claim.received?.files ?? [])]) {
        const dir = parentOf(clean(path));
        const set = inFolder.get(dir) ?? new Set<string>();
        set.add(claim.agentId);
        inFolder.set(dir, set);
      }
    }
    const folder = (raw: string): OwnerView | null => {
      const holders = inFolder.get(clean(raw));
      if (!holders || holders.size === 0) return null;
      const ids = [...holders];
      const line =
        ids.length === 1
          ? `${fullName(ids[0] ?? "")} has files in this folder`
          : `${ids.length} agents have files in this folder`;
      return { tone: ids.length > 1 ? "shared" : "working", lines: [line], label: line };
    };
    return { file, folder };
  }, [ownership, workspaceId]);
}

/** A tiny dot beside a file or folder name; the words live in the tooltip and the row's name. */
export function OwnerMarker({ view }: { view: OwnerView }) {
  return (
    <Tooltip
      content={
        <span className={styles.ownerTip}>
          {view.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static lines of one tooltip.
            <span key={index}>{line}</span>
          ))}
        </span>
      }
    >
      <span className={styles.owner} data-tone={view.tone} data-owner-marker aria-hidden="true" />
    </Tooltip>
  );
}
