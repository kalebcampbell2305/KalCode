import { Badge, Button, ErrorState, ProviderGlyph, Skeleton, StatusChip, TextInput } from "@kalcode/ui/components";
import { Search } from "lucide-react";
import { type KeyboardEvent, type RefObject, useEffect, useState } from "react";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { matchesQuery, presentThread } from "./model.ts";
import styles from "./ThreadList.module.css";
import type { useThreadList } from "./useThreads.ts";

interface ThreadListProps {
  list: ReturnType<typeof useThreadList>;
  query: string;
  onQueryChange: (query: string) => void;
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
  selectedId: string | null;
  onSelect: (threadId: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Arrow keys move between rows (the list is also reachable with Tab). */
function onListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-thread-row]")];
  if (rows.length === 0) return;
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : event.key === "ArrowDown"
          ? Math.min(rows.length - 1, index + 1)
          : Math.max(0, index - 1);
  event.preventDefault();
  rows[next]?.focus();
}

export function ThreadList({
  list,
  query,
  onQueryChange,
  showArchived,
  onShowArchivedChange,
  selectedId,
  onSelect,
  searchRef,
}: ThreadListProps) {
  const now = useNow();
  const shown = list.entries.filter((entry) => matchesQuery(entry.thread, query));

  return (
    <section className={styles.pane} aria-label="Thread list">
      <div className={styles.toolbar}>
        <div className={styles.toolbarHead}>
          <p className={styles.eyebrow}>{showArchived ? "Recent · with archived" : "Recent"}</p>
          {list.state === "ready" ? (
            <span className={styles.total}>
              {query.trim() ? `${shown.length} of ${list.entries.length}` : list.entries.length}
            </span>
          ) : null}
        </div>
        <span className={styles.searchWrap}>
          <Search className={styles.searchIcon} aria-hidden="true" />
          <TextInput
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search threads"
            aria-label="Search threads"
            className={styles.search}
          />
        </span>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => onShowArchivedChange(event.target.checked)}
          />
          Show archived
        </label>
      </div>

      {list.state === "loading" ? (
        <div className={styles.loading} role="status" aria-busy="true">
          <span className="visually-hidden">Loading threads</span>
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.skeletonRow}>
              <Skeleton width={`${70 - i * 12}%`} />
              <Skeleton width="45%" />
            </div>
          ))}
        </div>
      ) : list.state === "error" ? (
        <div className={styles.message}>
          <ErrorState
            title="Threads couldn't load"
            code={list.error ? `${list.error.category}/${list.error.code}` : undefined}
            actions={<Button onClick={list.retry}>Try again</Button>}
          >
            <p>{list.error?.message ?? "KalCode couldn't read your threads."} Your data is unchanged.</p>
          </ErrorState>
        </div>
      ) : shown.length === 0 ? (
        <p className={styles.message}>
          {list.entries.length === 0 ? "No threads yet." : `No threads match "${query.trim()}".`}
        </p>
      ) : (
        <ul className={styles.list} aria-label="Threads" onKeyDown={onListKeyDown}>
          {shown.map(({ thread, archived }) => {
            const status = presentThread(thread);
            const selected = thread.id === selectedId;
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  data-thread-row
                  className={styles.row}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect(thread.id)}
                >
                  <span className={styles.nameRow}>
                    <span className={styles.name}>
                      {thread.unreadMessages > 0 ? (
                        <span className={styles.unread}>
                          <span className="visually-hidden">
                            {thread.unreadMessages === 1
                              ? "1 unread message, "
                              : `${thread.unreadMessages} unread messages, `}
                          </span>
                        </span>
                      ) : null}
                      <span className={styles.nameText} title={thread.name}>
                        {thread.name}
                      </span>
                    </span>
                    <time
                      className={styles.time}
                      dateTime={thread.lastActivityAt}
                      title={formatAbsolute(thread.lastActivityAt)}
                    >
                      {formatRelative(thread.lastActivityAt, now)}
                    </time>
                  </span>
                  <span className={styles.status}>
                    <StatusChip
                      variant="inline"
                      size="sm"
                      status={status.display}
                      tone={status.tone}
                      label={status.label}
                    />
                    {thread.currentActivity && thread.status !== "waiting_for_permission" ? (
                      <span className={styles.activity}>{thread.currentActivity}</span>
                    ) : null}
                  </span>
                  <span className={styles.meta}>
                    <ProviderGlyph provider={thread.providerId} size="xs" />
                    <span className={styles.metaText}>
                      {thread.providerName}
                      {thread.accountLabel ? ` · ${thread.accountLabel}` : ""} · {thread.workspaceName}
                    </span>
                    {thread.pendingApprovals > 0 ? (
                      <Badge tone="waiting" className={styles.pending}>
                        {thread.pendingApprovals === 1 ? "1 approval" : `${thread.pendingApprovals} approvals`}
                      </Badge>
                    ) : null}
                    {archived ? <Badge tone="outline">Archived</Badge> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
