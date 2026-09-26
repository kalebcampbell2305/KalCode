import type { Notification } from "@kalcode/protocol";
import { Button, EmptyState, ErrorState, IconButton, SegmentedControl, Skeleton } from "@kalcode/ui/components";
import { BellRing, Check, CheckCheck, Circle, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { memo, useCallback, useMemo, useState } from "react";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { useNow } from "../../surfaces/dashboard/useNow.ts";
import { useVirtualRows } from "../../surfaces/dashboard/useVirtualRows.ts";
import { KIND_META, type NotificationRow, withDayHeadings } from "./model.ts";
import styles from "./NotificationCenter.module.css";
import { useNotifications } from "./NotificationsProvider.tsx";

type Show = "all" | "unread";

/**
 * The notification center (Z7-W3): a side sheet with every notification, newest first, grouped by
 * day. Opening one marks it read and focuses its thread, workspace or provider. Unread state is
 * stored natively and survives restarts.
 */
export function NotificationCenter() {
  const center = useNotifications();
  const { panelOpen, setPanelOpen, panelReturnFocus, unreadCount, state } = center;
  const [show, setShow] = useState<Show>("all");

  return (
    <>
      <Dialog.Root open={panelOpen} onOpenChange={setPanelOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content
            className={styles.sheet}
            aria-describedby="notifications-description"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              panelReturnFocus();
            }}
          >
            <header className={styles.header}>
              <div>
                <Dialog.Title className={styles.title}>Notifications</Dialog.Title>
                <Dialog.Description id="notifications-description" className={styles.description}>
                  {unreadCount === 0 ? "You're all caught up." : `${unreadCount} unread`}
                </Dialog.Description>
              </div>
              <div className={styles.headerActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<CheckCheck />}
                  disabled={unreadCount === 0}
                  onClick={() => void center.mark(null, "read")}
                >
                  Mark all read
                </Button>
                <Dialog.Close asChild>
                  <IconButton label="Close notifications" icon={<X />} />
                </Dialog.Close>
              </div>
            </header>
            {state === "ready" && center.notifications.length > 0 ? (
              <div className={styles.filter}>
                <SegmentedControl<Show>
                  aria-label="Show"
                  value={show}
                  options={[
                    { value: "all", label: "All" },
                    { value: "unread", label: `Unread (${unreadCount})` },
                  ]}
                  onValueChange={setShow}
                />
              </div>
            ) : null}
            <div className={styles.body}>
              <CenterBody show={show} />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <NotificationAnnouncer />
    </>
  );
}

function CenterBody({ show }: { show: Show }) {
  const { state, error, notifications, refresh, hasMore, loadMore } = useNotifications();
  const now = useNow(30_000);
  const list = useMemo(
    () => (show === "unread" ? notifications.filter((n) => n.readAt === null) : notifications),
    [notifications, show],
  );
  const rows = useMemo(() => withDayHeadings(list, now), [list, now]);
  const getKey = useCallback((i: number) => rows[i]?.key ?? String(i), [rows]);
  const estimate = useCallback((i: number) => (rows[i]?.kind === "day" ? 36 : 92), [rows]);
  const virtual = useVirtualRows({ count: rows.length, getKey, estimate, threshold: 40 });

  if (state === "loading") {
    return (
      <div className={styles.loading} role="status" aria-busy="true">
        <span className="visually-hidden">Loading notifications</span>
        <Skeleton width="70%" />
        <Skeleton width="55%" />
      </div>
    );
  }
  if (state === "unavailable") {
    return (
      <EmptyState art={<BellRing />} title="Notifications aren't in this build">
        <p>This build doesn't include KalCode's notification center.</p>
      </EmptyState>
    );
  }
  if (state === "error") {
    return (
      <ErrorState
        title="Notifications couldn't load"
        actions={<Button onClick={() => void refresh()}>Try again</Button>}
      >
        <p>{error?.message}</p>
      </ErrorState>
    );
  }
  if (list.length === 0 && !hasMore) {
    return (
      <EmptyState art={<BellRing />} title={show === "unread" ? "Nothing unread" : "No notifications yet"}>
        <p>
          KalCode tells you here when an agent finishes, fails or needs your permission, when a provider signs out and
          when work can be resumed after a restart.
        </p>
      </EmptyState>
    );
  }
  return (
    <>
      {list.length === 0 ? (
        <EmptyState
          art={<BellRing />}
          title={show === "unread" ? "No unread notifications loaded" : "No notifications loaded"}
        >
          <p>
            {show === "unread" ? "Older notifications may still be unread." : "Load older notifications to continue."}
          </p>
        </EmptyState>
      ) : null}
      <div
        ref={virtual.containerRef}
        className={styles.rows}
        data-virtualized={virtual.virtualized || undefined}
        style={virtual.virtualized ? { height: virtual.total } : undefined}
      >
        {virtual.rows.map((vr) => {
          const row = rows[vr.index];
          if (!row) return null;
          return (
            <div
              key={vr.key}
              ref={virtual.measureRef(vr.key)}
              className={styles.row}
              style={virtual.virtualized ? { transform: `translateY(${vr.start}px)` } : undefined}
            >
              <RowView row={row} now={now} />
            </div>
          );
        })}
      </div>
      {hasMore ? (
        <div className={styles.more}>
          <Button size="sm" variant="ghost" onClick={() => void loadMore()}>
            Show older notifications
          </Button>
        </div>
      ) : null}
    </>
  );
}

function RowView({ row, now }: { row: NotificationRow; now: number }) {
  if (row.kind === "day") return <h3 className={styles.day}>{row.label}</h3>;
  return <NotificationItem notification={row.notification} now={now} />;
}

const NotificationItem = memo(function NotificationItem({
  notification,
  now,
}: {
  notification: Notification;
  now: number;
}) {
  const { open, mark } = useNotifications();
  const meta = KIND_META[notification.kind];
  const Icon = meta.icon;
  const unread = notification.readAt === null;
  const titleId = `notification-${notification.id}-title`;
  const bodyId = `notification-${notification.id}-body`;
  return (
    <article
      className={styles.item}
      aria-labelledby={titleId}
      data-unread={unread || undefined}
      data-tone={meta.tone}
      data-notification-id={notification.id}
    >
      <span className={styles.glyph} data-tone={meta.tone} aria-hidden="true">
        <Icon />
      </span>
      <div className={styles.content}>
        <button type="button" className={styles.open} onClick={() => void open(notification)} aria-describedby={bodyId}>
          <span id={titleId} className={styles.itemTitle}>
            {unread ? <span className="visually-hidden">Unread: </span> : null}
            {notification.title}
          </span>
        </button>
        <p id={bodyId} className={styles.itemBody}>
          {notification.body}
        </p>
        <p className={styles.meta}>
          <span>{meta.label}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={notification.updatedAt} title={formatAbsolute(notification.updatedAt)}>
            {formatRelative(notification.updatedAt, now)}
          </time>
          {notification.count > 1 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{notification.count} times</span>
            </>
          ) : null}
        </p>
      </div>
      <div className={styles.itemActions}>
        <IconButton
          size="sm"
          label={unread ? `Mark “${notification.title}” read` : `Mark “${notification.title}” unread`}
          icon={unread ? <Check /> : <Circle />}
          onClick={() => void mark([notification.id], unread ? "read" : "unread")}
        />
        <IconButton
          size="sm"
          label={`Dismiss “${notification.title}”`}
          icon={<X />}
          onClick={() => void mark([notification.id], "dismissed")}
        />
      </div>
    </article>
  );
});

/**
 * Announces notifications raised live. Permission requests are announced by the approvals
 * announcer (assertive), so they are not repeated here.
 */
function NotificationAnnouncer() {
  const { latest } = useNotifications();
  const text =
    latest && latest.kind !== "permission_required" ? `${KIND_META[latest.kind].label}: ${latest.title}` : null;
  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="announce-notification">
      {text && latest ? <p key={`${latest.id}@${latest.updatedAt}`}>{text}</p> : null}
    </div>
  );
}
