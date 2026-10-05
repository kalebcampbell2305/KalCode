/**
 * Needs You: KalCode's one attention inbox. Every item is something that genuinely needs the
 * person, and says WHAT happened, WHY it needs them and WHAT to do next. Items are derived from the
 * canonical state every other surface reads (the coding agents and their `agentStateOf` state, the
 * permission engine's pending approvals and the notification center's provider sign-outs); the
 * inbox keeps no copy of its own. Ordinary progress (an agent working, a turn finishing without
 * changes) never lands here.
 */
import { agentStateOf, type Notification, type ThreadSummary } from "@kalcode/protocol";

export type AttentionKind = "question" | "approval" | "failed" | "auth" | "stalled" | "review";

/** An action the item offers. The id is a canonical KalCode action (see `runtime/actions.tsx`). */
export type AttentionAction =
  | { id: "open-agent"; label: string; agentId: string; workspaceId: string }
  | { id: "retry-agent"; label: string; agentId: string }
  | { id: "open-approvals"; label: string }
  | { id: "sign-in"; label: string; providerId: string }
  | { id: "dismiss"; label: string };

export interface AttentionItem {
  /**
   * Stable for one occurrence: the same agent failing again later is a new key, so a dismissed
   * occurrence never hides the next one.
   */
  key: string;
  kind: AttentionKind;
  /** Higher sorts first: blocked work before things to look at. */
  rank: number;
  /** Who: "Codex · Billing Fix" (provider identity stays a small detail). */
  source: string;
  workspaceName: string | null;
  /** What happened, in a few words. */
  what: string;
  /** Why it needs the person. */
  why: string;
  actions: AttentionAction[];
  /** When it happened (RFC 3339). */
  at: string;
  /** The agent the item is about, when there is one. */
  agentId: string | null;
  /** Whether the person may dismiss it (states that clear themselves can't be dismissed). */
  dismissible: boolean;
}

/** An agent marked working that has shown no activity for this long is worth a look. */
export const STALLED_AFTER_MS = 20 * 60_000;
/**
 * Finished agents with changes, and failures, stay in the inbox this long unless dismissed. Older
 * ones stay in the Fleet (its Failed group folds when large), so old failures never bury new work.
 */
export const REVIEW_WINDOW_MS = 24 * 60 * 60_000;

const RANK: Record<AttentionKind, number> = {
  auth: 60,
  approval: 50,
  question: 50,
  failed: 40,
  stalled: 20,
  review: 10,
};

export interface AttentionInput {
  /** Open coding agents (any provider). */
  agents: readonly ThreadSummary[];
  /** Pending approvals from the permission engine. */
  approvals: readonly { id: string; action: { threadId?: string | null; summary: string; requestedAt: string } }[];
  /** The notification center's list (only unread provider sign-outs are used). */
  notifications: readonly Notification[];
  /** Keys the person dismissed. */
  dismissed: ReadonlySet<string>;
  now: number;
}

function at(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** "Codex · Billing Fix": the provider, then the agent's own (task or custom) name. */
export function sourceOf(agent: Pick<ThreadSummary, "providerName" | "name">): string {
  const name = agent.name.trim();
  return name && name !== agent.providerName ? `${agent.providerName} · ${name}` : agent.providerName;
}

function openAgent(agent: ThreadSummary): AttentionAction {
  return { id: "open-agent", label: "Open agent", agentId: agent.id, workspaceId: agent.workspaceId };
}

function agentItem(agent: ThreadSummary, now: number): Omit<AttentionItem, "rank"> | null {
  const state = agentStateOf(agent);
  const base = {
    source: sourceOf(agent),
    workspaceName: agent.workspaceName || null,
    at: agent.lastActivityAt,
    agentId: agent.id,
  };
  if (state === "needs_you") {
    if (agent.pendingApprovals > 0 || agent.status === "waiting_for_permission") {
      return {
        ...base,
        key: `approval:${agent.id}:${agent.lastActivityAt}`,
        kind: "approval",
        what: "Needs your permission",
        why: agent.currentActivity?.trim() || "It can't continue until you allow or deny its next step.",
        actions: [openAgent(agent), { id: "open-approvals", label: "Review" }],
        dismissible: false,
      };
    }
    return {
      ...base,
      key: `question:${agent.id}:${agent.lastActivityAt}`,
      kind: "question",
      what: "Asked you a question",
      why: agent.currentActivity?.trim() || "It's waiting for your reply before it can continue.",
      actions: [openAgent(agent)],
      dismissible: false,
    };
  }
  if (state === "failed") {
    if (now - at(agent.lastActivityAt) > REVIEW_WINDOW_MS) return null;
    return {
      ...base,
      key: `failed:${agent.id}:${agent.lastActivityAt}`,
      kind: "failed",
      what: agent.status === "failed" ? "Failed" : "Last turn failed",
      why: agent.error?.message.trim() || "Its last run ended with an error. Open it to see what happened.",
      actions: [
        openAgent(agent),
        ...(agent.status === "failed" ? [{ id: "retry-agent", label: "Retry", agentId: agent.id } as const] : []),
      ],
      dismissible: true,
    };
  }
  if (state === "working" || state === "testing") {
    const quiet = now - at(agent.lastActivityAt);
    if (at(agent.lastActivityAt) > 0 && quiet >= STALLED_AFTER_MS) {
      return {
        ...base,
        key: `stalled:${agent.id}:${agent.lastActivityAt}`,
        kind: "stalled",
        what: `No activity for ${minutes(quiet)}`,
        why: "It's still marked working, but nothing has happened since. It may be stuck on a long command or waiting on something.",
        actions: [openAgent(agent)],
        dismissible: true,
      };
    }
    return null;
  }
  if (state === "done" && (agent.filesChanged ?? 0) > 0 && now - at(agent.lastActivityAt) <= REVIEW_WINDOW_MS) {
    const files = agent.filesChanged ?? 0;
    return {
      ...base,
      key: `review:${agent.id}:${agent.lastActivityAt}`,
      kind: "review",
      what: `Finished · ${files} ${files === 1 ? "file" : "files"} changed`,
      why: agent.branch
        ? `Its work on ${agent.branch} is ready for you to review.`
        : "Its changes are ready for you to review.",
      actions: [
        { ...openAgent(agent), label: "Review" },
        { id: "dismiss", label: "Mark reviewed" },
      ],
      dismissible: true,
    };
  }
  return null;
}

/** Every item that needs the person, most urgent first, newest first within a kind. */
export function attentionItems({ agents, approvals, notifications, dismissed, now }: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const agentIds = new Set<string>();
  for (const agent of agents) {
    if (agent.archivedAt !== null) continue;
    agentIds.add(agent.id);
    const item = agentItem(agent, now);
    if (item && !(item.dismissible && dismissed.has(item.key))) items.push({ ...item, rank: RANK[item.kind] });
  }
  // Approvals that no listed agent accounts for (a chat thread, KalVoice, a utility): one each.
  for (const approval of approvals) {
    const threadId = approval.action.threadId;
    if (threadId && agentIds.has(threadId)) continue;
    items.push({
      key: `approval:${approval.id}`,
      kind: "approval",
      rank: RANK.approval,
      source: "Approval",
      workspaceName: null,
      what: "Waiting for your decision",
      why: approval.action.summary.trim() || "An action is waiting for you to allow or deny it.",
      actions: [{ id: "open-approvals", label: "Review" }],
      at: approval.action.requestedAt,
      agentId: null,
      dismissible: false,
    });
  }
  // A provider that signed out blocks every agent that uses it. Newest notice per provider.
  const providers = new Set<string>();
  for (const notification of notifications) {
    if (notification.kind !== "provider_disconnected" || notification.readAt !== null) continue;
    const providerId = notification.entityId ?? "";
    if (providers.has(providerId)) continue;
    providers.add(providerId);
    const key = `auth:${notification.id}:${notification.updatedAt}`;
    if (dismissed.has(key)) continue;
    items.push({
      key,
      kind: "auth",
      rank: RANK.auth,
      source: notification.title.replace(/ is signed out$/, "") || "Provider",
      workspaceName: null,
      what: "Signed out",
      why: notification.body,
      actions: [
        { id: "sign-in", label: "Sign in", providerId },
        { id: "dismiss", label: "Dismiss" },
      ],
      at: notification.updatedAt,
      agentId: null,
      dismissible: true,
    });
  }
  return items.sort((a, b) => b.rank - a.rank || at(b.at) - at(a.at) || a.key.localeCompare(b.key));
}

/**
 * "2 blocked on you · 3 to review": what the inbox holds, by how it waits on the person. Blocked
 * means an agent or provider can't continue without them; review and stalled are worth a look.
 * Provider-neutral, zeros left out.
 */
export function attentionSummary(items: readonly AttentionItem[]): string {
  if (items.length === 0) return "Nothing needs you";
  const count = (...kinds: AttentionKind[]) => items.filter((item) => kinds.includes(item.kind)).length;
  const blocked = count("question", "approval", "failed", "auth");
  const review = count("review");
  const stalled = count("stalled");
  return [
    blocked ? `${blocked} blocked on you` : null,
    review ? `${review} to review` : null,
    stalled ? `${stalled} stalled` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
