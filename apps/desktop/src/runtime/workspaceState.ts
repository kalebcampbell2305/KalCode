import type { EventEnvelope, ShellOption, TerminalInfo, Workspace } from "@kalcode/protocol";

/** Events after which workspace and terminal state must be re-read. */
export function isWorkspaceEvent(event: EventEnvelope): boolean {
  return event.type.startsWith("workspace.") || event.type.startsWith("shell.");
}

/**
 * The tab in front: the user's latest choice if that tab still exists, else the persisted
 * choice, else the first tab.
 */
export function pickActiveTerminal(
  terminals: readonly TerminalInfo[],
  selected: string | null,
  persisted: string | null,
): string | null {
  const exists = (id: string | null) => id !== null && terminals.some((t) => t.id === id);
  if (exists(selected)) return selected;
  if (exists(persisted)) return persisted;
  return terminals[0]?.id ?? null;
}

/**
 * Tab labels: the shell's name, numbered when a workspace has several tabs of the same shell
 * ("PowerShell 7", "PowerShell 7 (2)").
 */
export function tabLabels(terminals: readonly TerminalInfo[]): Map<string, string> {
  const seen = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const t of terminals) totals.set(t.title, (totals.get(t.title) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const t of terminals) {
    const n = (seen.get(t.title) ?? 0) + 1;
    seen.set(t.title, n);
    labels.set(t.id, (totals.get(t.title) ?? 0) > 1 && n > 1 ? `${t.title} (${n})` : t.title);
  }
  return labels;
}

/** The tab to show after `closing` closes: its right neighbour, else its left, else none. */
export function neighbourAfterClose(terminals: readonly TerminalInfo[], closing: string): string | null {
  const index = terminals.findIndex((t) => t.id === closing);
  if (index === -1) return null;
  return terminals[index + 1]?.id ?? terminals[index - 1]?.id ?? null;
}

/** Cycles through tabs (Ctrl+Tab / Ctrl+Shift+Tab), wrapping around. */
export function cycleTerminal(terminals: readonly TerminalInfo[], current: string | null, step: 1 | -1): string | null {
  if (terminals.length === 0) return null;
  const index = terminals.findIndex((t) => t.id === current);
  const next = index === -1 ? 0 : (index + step + terminals.length) % terminals.length;
  return terminals[next]?.id ?? null;
}

/** Plain-language status of a tab for its label, tooltip and the Dashboard. */
export function describeTerminalStatus(terminal: TerminalInfo): string {
  switch (terminal.status) {
    case "running":
      return "Running";
    case "exited":
      return terminal.exitCode === 0 || terminal.exitCode === null
        ? "Exited"
        : `Exited with code ${terminal.exitCode}`;
    case "ended_by_app":
      return "Ended when KalCode closed";
  }
}

export function defaultShell(shells: readonly ShellOption[]): ShellOption | null {
  return shells.find((s) => s.isDefault) ?? shells[0] ?? null;
}

/** Running terminals grouped by workspace, in the workspace list's order. */
export function groupRunning(
  running: readonly TerminalInfo[],
  workspaces: readonly Workspace[],
): { workspace: Workspace | null; workspaceId: string; terminals: TerminalInfo[] }[] {
  const groups = new Map<string, TerminalInfo[]>();
  for (const t of running) groups.set(t.workspaceId, [...(groups.get(t.workspaceId) ?? []), t]);
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const order = (id: string) => {
    const index = workspaces.findIndex((w) => w.id === id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => order(a) - order(b))
    .map(([workspaceId, terminals]) => ({ workspace: byId.get(workspaceId) ?? null, workspaceId, terminals }));
}
