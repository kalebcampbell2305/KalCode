/**
 * Notification center fixtures for the in-memory transport (unit tests and the `ui-test` build
 * ONLY — never bundled into development or production builds).
 *
 * Mirrors `crates/notifications` (Z7-W3): notifications are derived from the same events, with
 * the same words, and the same policy — coalescing into an unread notification with the same
 * (kind, entity), a 10-second per-entity cooldown, a budget of 30 new notifications a minute and
 * retention of the newest 500. `notification_list` / `notification_mark` validate like native.
 */
import type {
  EventEnvelope,
  IpcError,
  Notification,
  NotificationEntityKind,
  NotificationKind,
  NotificationMark,
  NotificationPage,
  Severity,
  ThreadSummary,
} from "@kalcode/protocol";
import type { DashboardHandlers, Emit } from "./dashboard.ts";
import { isValidId } from "./dashboard.ts";

/** Mirrors `kalcode_threads::runtime::RECOVERED_ACTIVITY`. */
export const RECOVERED_ACTIVITY = "KalCode closed while this thread was running";

const COOLDOWN_MS = 10_000;
const BUDGET_PER_MINUTE = 30;
const RETENTION = 500;
const MAX_BODY = 240;
const MAX_LIMIT = 200;
const MAX_IDS = 500;

const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

interface Draft {
  kind: NotificationKind;
  severity: Severity;
  title: string;
  body: string;
  entityKind: NotificationEntityKind | null;
  entityId: string | null;
  workspaceId: string | null;
}

interface Row extends Notification {
  dismissedAt: string | null;
}

export interface NotificationsMemory {
  handlers: DashboardHandlers;
  /** Feed every recorded event (the native worker subscribes to the event bus). */
  observe(event: EventEnvelope): void;
}

function fail(error: IpcError): never {
  throw error;
}

function truncate(text: string): string {
  const chars = [...text];
  return chars.length <= MAX_BODY ? text : `${chars.slice(0, MAX_BODY - 1).join("")}…`;
}

export function createNotificationsMemory(options: {
  emit: Emit;
  lookupThread: (threadId: string) => ThreadSummary | null;
  /** Runs work just after the current event (default: a zero-delay timer). */
  settle?: (work: () => void) => void;
}): NotificationsMemory {
  const { emit, lookupThread, settle = (work) => setTimeout(work, 0) } = options;
  let rows: Row[] = [];
  const recentCreates: number[] = [];

  const threadDraft = (threadId: string) => {
    const thread = lookupThread(threadId);
    return {
      name: thread?.name ?? "A thread",
      provider: thread?.providerName ?? "Its provider",
      workspace: thread?.workspaceName ?? "its workspace",
      workspaceId: thread?.workspaceId ?? null,
    };
  };

  const derive = (event: EventEnvelope): Draft | null => {
    switch (event.type) {
      case "thread.completed": {
        const t = threadDraft(event.payload.threadId);
        return {
          kind: "thread_completed",
          severity: "info",
          title: `${t.name} completed`,
          body: `${t.provider} · ${t.workspace}`,
          entityKind: "thread",
          entityId: event.payload.threadId,
          workspaceId: t.workspaceId,
        };
      }
      case "thread.failed": {
        const t = threadDraft(event.payload.threadId);
        return {
          kind: "thread_failed",
          severity: "critical",
          title: `${t.name} failed`,
          body: truncate(event.payload.message),
          entityKind: "thread",
          entityId: event.payload.threadId,
          workspaceId: t.workspaceId,
        };
      }
      case "approval.requested": {
        const t = threadDraft(event.payload.threadId);
        return {
          kind: "permission_required",
          severity: "warning",
          title: `${t.name} needs your permission`,
          body: truncate(event.payload.summary),
          entityKind: "thread",
          entityId: event.payload.threadId,
          workspaceId: t.workspaceId,
        };
      }
      case "provider.disconnected": {
        const name = PROVIDER_NAMES[event.payload.providerId] ?? event.payload.providerId;
        return {
          kind: "provider_disconnected",
          severity: "warning",
          title: `${name} is signed out`,
          body: `Threads that use ${name} can't start until you sign in again.`,
          entityKind: "provider",
          entityId: event.payload.providerId,
          workspaceId: null,
        };
      }
      case "thread.status_changed":
        if (
          event.source === "core" &&
          event.payload.to === "interrupted" &&
          event.payload.detail === RECOVERED_ACTIVITY
        ) {
          return {
            kind: "recovery_available",
            severity: "info",
            title: "1 thread can be resumed",
            body: "They were running when KalCode closed. Resume them from the Dashboard.",
            entityKind: null,
            entityId: null,
            workspaceId: null,
          };
        }
        return null;
      default:
        return null;
    }
  };

  const created = (row: Row, occurredAt: string) =>
    emit(
      {
        type: "notification.created",
        payload: {
          notificationId: row.id,
          kind: row.kind,
          severity: row.severity,
          entityKind: row.entityKind,
          entityId: row.entityId,
        },
      },
      {
        occurredAt,
        correlation: {
          threadId: row.entityKind === "thread" ? row.entityId : null,
          workspaceId: row.workspaceId,
          providerId: row.entityKind === "provider" ? row.entityId : null,
        },
      },
    );

  const sameKey = (row: Row, draft: Draft) =>
    row.kind === draft.kind && row.entityKind === draft.entityKind && row.entityId === draft.entityId;

  const record = (draft: Draft, occurredAt: string) => {
    const at = Date.parse(occurredAt);
    const live = rows.find((r) => sameKey(r, draft) && r.readAt === null && r.dismissedAt === null);
    const recent = rows.find(
      (r) => sameKey(r, draft) && r.dismissedAt === null && at - Date.parse(r.updatedAt) < COOLDOWN_MS,
    );
    const target = live ?? recent;
    if (target) {
      target.count += 1;
      target.title = draft.kind === "recovery_available" ? `${target.count} threads can be resumed` : draft.title;
      target.body = draft.body;
      target.updatedAt = occurredAt;
      target.readAt = null;
      created(target, occurredAt);
      return;
    }
    while (recentCreates.length > 0 && at - (recentCreates[0] ?? 0) >= 60_000) recentCreates.shift();
    if (recentCreates.length >= BUDGET_PER_MINUTE) return;
    recentCreates.push(at);
    const row: Row = {
      id: crypto.randomUUID(),
      ...draft,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      readAt: null,
      count: 1,
      dismissedAt: null,
    };
    rows.unshift(row);
    if (rows.length > RETENTION) rows = rows.slice(0, RETENTION);
    created(row, occurredAt);
  };

  const observe = (event: EventEnvelope) => {
    if (event.type.startsWith("notification.")) return;
    if (event.type === "approval.approved" || event.type === "approval.denied" || event.type === "approval.expired") {
      // The request was answered elsewhere: once the thread has none left, its notice is read.
      // Like the native worker, this runs just after the event (the thread's count settles first).
      const { threadId } = event.payload;
      const at = event.occurredAt;
      settle(() => {
        const thread = lookupThread(threadId);
        if (thread?.pendingApprovals !== 0) return;
        for (const row of rows) {
          if (row.kind === "permission_required" && row.entityId === threadId && row.readAt === null) row.readAt = at;
        }
      });
      return;
    }
    const draft = derive(event);
    if (draft) record(draft, event.occurredAt);
  };

  const ordered = () =>
    rows
      .filter((r) => r.dismissedAt === null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));

  const publicRow = ({ dismissedAt: _dismissed, ...row }: Row): Notification => ({ ...row });

  const handlers: DashboardHandlers = {
    notification_list: (args): NotificationPage => {
      const limit = Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        fail({
          category: "validation",
          code: "invalid_page_size",
          message: `Page size must be between 1 and ${MAX_LIMIT}.`,
          retryable: false,
        });
      }
      const before = typeof args.before === "string" ? args.before : null;
      if (before !== null && before.length > 128) {
        fail({
          category: "validation",
          code: "invalid_cursor",
          message: "That page cursor isn't valid.",
          retryable: false,
        });
      }
      let list = ordered();
      if (args.unreadOnly === true) list = list.filter((r) => r.readAt === null);
      if (before) {
        const [updatedAt, id] = before.split("|");
        list = list.filter((r) => r.updatedAt < (updatedAt ?? "") || (r.updatedAt === updatedAt && r.id < (id ?? "")));
      }
      const page = list.slice(0, limit);
      const last = page[page.length - 1];
      return {
        notifications: page.map(publicRow),
        nextCursor: page.length === limit && list.length > limit && last ? `${last.updatedAt}|${last.id}` : null,
        unreadCount: ordered().filter((r) => r.readAt === null).length,
      };
    },
    notification_mark: (args): number => {
      const mark = args.mark as NotificationMark;
      if (mark !== "read" && mark !== "unread" && mark !== "dismissed") {
        fail({
          category: "internal",
          code: "ipc_rejected",
          message: "KalCode couldn't complete that request.",
          retryable: false,
        });
      }
      const ids = args.ids;
      if (ids !== null && (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every(isValidId))) {
        fail({ category: "validation", code: "invalid_id", message: "That id isn't valid.", retryable: false });
      }
      const targets = ordered().filter((r) => ids === null || (ids as string[]).includes(r.id));
      const now = new Date().toISOString();
      let changed = 0;
      for (const row of targets) {
        if (mark === "read" && row.readAt === null) {
          row.readAt = now;
          changed += 1;
        } else if (mark === "unread" && row.readAt !== null) {
          row.readAt = null;
          changed += 1;
        } else if (mark === "dismissed") {
          row.dismissedAt = now;
          changed += 1;
        }
      }
      return changed;
    },
  };

  return { handlers, observe };
}
