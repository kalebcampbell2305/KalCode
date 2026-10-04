import type {
  LocatorEntityKind,
  LocatorInterpretation,
  LocatorResult,
  LocatorStatusFilter,
  MatchRange,
} from "@kalcode/protocol";
import { DISPLAY_STATUS_GLYPH } from "@kalcode/ui/components";
import { Command } from "cmdk";
import {
  Activity,
  Bot,
  CalendarClock,
  FileText,
  Flag,
  FolderClosed,
  FolderGit2,
  GitBranch,
  History,
  type LucideIcon,
  MessagesSquare,
  PlugZap,
  SquareTerminal,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import styles from "./LocatorResults.module.css";
import type { LocatorSearchState } from "./useLocatorSearch.ts";

export const KIND_ICON: Record<LocatorEntityKind, LucideIcon> = {
  thread: MessagesSquare,
  workspace: FolderClosed,
  remote_workspace: FolderGit2,
  terminal: SquareTerminal,
  provider: PlugZap,
  agent: Bot,
  mission: Flag,
  task: Workflow,
  worktree: GitBranch,
  automation: CalendarClock,
  file: FileText,
  command: TerminalSquare,
  activity: History,
};

export const KIND_LABEL: Record<LocatorEntityKind, string> = {
  thread: "Thread",
  workspace: "Workspace",
  remote_workspace: "Remote workspace",
  terminal: "Terminal",
  provider: "Provider",
  agent: "Agent",
  mission: "Mission",
  task: "Task",
  worktree: "Worktree",
  automation: "Automation",
  file: "File",
  command: "Command",
  activity: "Activity",
};

/** The kinds the palette offers as filters (the ones indexed today). */
export const FILTER_KINDS: readonly { id: LocatorEntityKind | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "thread", label: "Threads" },
  { id: "workspace", label: "Workspaces" },
  { id: "terminal", label: "Terminals" },
  { id: "provider", label: "Providers" },
  { id: "activity", label: "Activity" },
];

const STATUS_LABEL: Record<string, string> = {
  starting: "Starting",
  working: "Working",
  testing: "Testing",
  reviewing: "Reviewing",
  permission_required: "Permission required",
  waiting_for_you: "Waiting for you",
  idle: "Idle",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  recovering: "Recovering",
  offline: "Offline",
  running: "Running",
  ended: "Ended",
  available: "",
  missing: "Folder missing",
  archived: "Archived",
  ready: "Ready",
  signed_out: "Signed out",
  not_installed: "Not installed",
  outdated: "Update needed",
  unknown: "",
};

const FILTER_WORDS: Record<LocatorStatusFilter, string> = {
  working: "Working",
  needs_you: "Needs you",
  done: "Done",
  failed: "Failed",
  idle: "Idle",
  archived: "Archived",
};

const RECENCY_WORDS: Record<string, string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  last_week: "Last week",
  this_month: "This month",
};

const PROVIDER_WORDS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "gemini-cli": "Gemini CLI",
};

/** The title with the matched parts marked (character ranges from native). */
export function HighlightedTitle({
  title,
  highlights,
}: {
  title: string;
  highlights: readonly MatchRange[];
}): ReactNode {
  const chars = [...title];
  if (highlights.length === 0) return title;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const { start, end } of highlights) {
    if (start < at || end <= start || end > chars.length) continue;
    if (start > at) parts.push(chars.slice(at, start).join(""));
    parts.push(
      <mark key={start} className={styles.mark}>
        {chars.slice(start, end).join("")}
      </mark>,
    );
    at = end;
  }
  if (at < chars.length) parts.push(chars.slice(at).join(""));
  return parts;
}

/** Filter words the locator understood, as chips ("Yesterday", "Threads", "Needs you"). */
export function interpretationChips(interpreted: LocatorInterpretation | undefined): string[] {
  if (!interpreted) return [];
  const chips: string[] = [];
  if (interpreted.recency) chips.push(RECENCY_WORDS[interpreted.recency] ?? interpreted.recency);
  for (const kind of interpreted.kinds) chips.push(`${KIND_LABEL[kind]}s`);
  for (const status of interpreted.statuses) chips.push(FILTER_WORDS[status]);
  if (interpreted.providerId) chips.push(PROVIDER_WORDS[interpreted.providerId] ?? interpreted.providerId);
  if (interpreted.activeOnly) chips.push("Right now");
  return chips;
}

/** Kind filter + what the query was understood as. Sits between the palette input and list. */
export function LocatorFilterBar({
  state,
  kinds,
  onKinds,
}: {
  state: LocatorSearchState;
  kinds: readonly LocatorEntityKind[];
  onKinds: (kinds: readonly LocatorEntityKind[]) => void;
}) {
  const chips = interpretationChips(state.response?.interpreted);
  const expanded = state.response?.interpreted.expanded ?? [];
  const selected = kinds.length === 1 ? kinds[0] : "all";
  return (
    <div className={styles.bar}>
      <fieldset className={styles.kinds}>
        <legend className="visually-hidden">Search in</legend>
        {FILTER_KINDS.map((kind) => (
          <button
            key={kind.id}
            type="button"
            className={styles.kind}
            aria-pressed={selected === kind.id}
            onClick={() => onKinds(kind.id === "all" ? [] : [kind.id])}
          >
            {kind.label}
          </button>
        ))}
      </fieldset>
      {chips.length > 0 || expanded.length > 0 ? (
        <p className={styles.understood}>
          {chips.length > 0 ? (
            <>
              <span className={styles.understoodLabel}>Filters</span>
              {chips.map((chip) => (
                <span key={chip} className={styles.chip}>
                  {chip}
                </span>
              ))}
            </>
          ) : null}
          {expanded.length > 0 ? (
            <span className={styles.also}>Also matching {expanded.slice(0, 4).join(", ")}</span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** Locator results as palette items (always shown: native already filtered and ranked them). */
export function LocatorResultItems({
  state,
  onOpen,
}: {
  state: LocatorSearchState;
  onOpen: (result: LocatorResult) => void;
}) {
  const items = state.response?.results.items ?? [];
  const total = state.response?.results.totalEstimate ?? items.length;
  const heading = state.error
    ? "Search"
    : state.loading && !state.response
      ? "Searching…"
      : `Sessions and places · ${total} ${total === 1 ? "match" : "matches"}`;
  return (
    <Command.Group heading={heading} className={styles.group} forceMount>
      {state.error ? (
        <p className={styles.note} role="alert">
          {state.error.message}
        </p>
      ) : null}
      {items.map((item) => {
        const Icon = KIND_ICON[item.kind];
        const status = item.status ? STATUS_LABEL[item.status] : "";
        const StatusGlyph =
          item.kind === "thread" && item.status && item.status in DISPLAY_STATUS_GLYPH
            ? DISPLAY_STATUS_GLYPH[item.status as keyof typeof DISPLAY_STATUS_GLYPH]
            : null;
        return (
          <Command.Item
            key={`${item.kind}:${item.entityId}`}
            value={`locator:${item.kind}:${item.entityId}`}
            className={styles.item}
            forceMount
            onSelect={() => onOpen(item)}
          >
            <span className={styles.icon} data-kind={item.kind} aria-hidden="true">
              <Icon />
            </span>
            <span className={styles.text}>
              <span className={styles.title}>
                <HighlightedTitle title={item.title} highlights={item.highlights} />
              </span>
              <span className={styles.sub}>
                <span className={styles.kindLabel}>{KIND_LABEL[item.kind]}</span>
                {item.subtitle ? (
                  <span className={styles.subtitle}>
                    {item.subtitle.replace(/^(Workspace|Terminal|Provider|Activity) · /, "")}
                  </span>
                ) : null}
                {item.snippet ? <span className={styles.snippet}>{item.snippet}</span> : null}
              </span>
            </span>
            {status ? (
              <span className={styles.status} data-status={item.status}>
                {StatusGlyph ? <StatusGlyph aria-hidden="true" /> : null}
                {status}
              </span>
            ) : null}
          </Command.Item>
        );
      })}
      {!state.loading && !state.error && items.length === 0 && state.response ? (
        <p className={styles.note}>
          <Activity aria-hidden="true" /> Nothing in threads, workspaces, terminals or activity matches that.
        </p>
      ) : null}
    </Command.Group>
  );
}
