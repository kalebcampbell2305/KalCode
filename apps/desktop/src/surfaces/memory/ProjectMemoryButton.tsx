import { limitsFor, type MemoryRecord } from "@kalcode/protocol";
import { Button, Skeleton, Tooltip } from "@kalcode/ui/components";
import { ArrowUpRight, BrainCircuit, FileText, Pin, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useOptionalAccount } from "../../account/AccountProvider.tsx";
import { planTier } from "../../ipc/account.ts";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import styles from "./ProjectMemoryButton.module.css";
import { CATEGORY_LABEL, memoryCountLine, projectMemoryView, sharingLine } from "./projectMemory.ts";

type Load =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; records: MemoryRecord[]; sharing: boolean | null }
  | { status: "error"; message: string };

/**
 * Project memory where the work happens: a small Code header button that opens the active
 * project's Unified Memory — counts, pinned notes and an instant filter — without leaving Code.
 * Nothing is read until it opens (the popover itself appears at once and fills in place); editing
 * and removal stay in Unified Memory, the one place that changes memory.
 */
export function ProjectMemoryButton({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const { client } = useRuntime();
  const { navigate } = useNavigation();
  const automatic = limitsFor(planTier(useOptionalAccount()?.snapshot)).memory !== "basic";
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ status: "idle" });
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const headingId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const empty = load.status === "ready" && load.records.length === 0;

  useEffect(() => {
    void attempt;
    if (!open) return;
    let cancelled = false;
    // Keep what was shown while a reopen refreshes it; only a first read shows the skeleton.
    setLoad((current) => (current.status === "ready" ? current : { status: "loading" }));
    Promise.all([
      client.listUnifiedMemory(workspaceId, ""),
      client.unifiedMemoryPreferences(workspaceId).then(
        (settings) => settings.sharingEnabled,
        () => null,
      ),
    ]).then(
      ([records, sharing]) => {
        if (!cancelled) setLoad({ status: "ready", records, sharing });
      },
      (cause: unknown) => {
        if (!cancelled) setLoad({ status: "error", message: toKalCodeError(cause).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, open, attempt]);

  // Until the person types or clicks, focus follows what's useful: the filter when there are notes
  // to filter, otherwise the way to add some. (A reopen can start from a cached empty list.)
  const untouched = useRef(true);
  useEffect(() => {
    if (!open || !untouched.current) return;
    (empty ? openRef.current : searchRef.current)?.focus();
  }, [open, empty]);

  const view = useMemo(() => (load.status === "ready" ? projectMemoryView(load.records, query) : null), [load, query]);

  const openMemory = () => {
    setOpen(false);
    navigate("memory");
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        untouched.current = true;
        if (!next) setQuery("");
      }}
    >
      <Tooltip content="Project memory: decisions, conventions and context every agent can use">
        <Popover.Trigger asChild>
          <Button className={styles.trigger} icon={<BrainCircuit />} aria-label="Project memory" aria-haspopup="dialog">
            <span className={styles.triggerLabel}>Memory</span>
          </Button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          align="end"
          sideOffset={8}
          collisionPadding={10}
          aria-labelledby={headingId}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (searchRef.current ?? openRef.current)?.focus();
          }}
          onKeyDown={() => {
            untouched.current = false;
          }}
          onPointerDown={() => {
            untouched.current = false;
          }}
        >
          <header className={styles.header}>
            <span className={styles.mark} aria-hidden="true">
              <BrainCircuit />
            </span>
            <div className={styles.titles}>
              <h3 id={headingId} className={styles.title}>
                Project memory
              </h3>
              <p className={styles.subtitle}>
                <span className={styles.workspace}>{workspaceName}</span>
                {view ? <span className={styles.counts}>{memoryCountLine(view)}</span> : null}
              </p>
            </div>
          </header>

          {empty ? null : (
            <label className={styles.search}>
              <Search aria-hidden="true" />
              <span className="visually-hidden">Filter project memory</span>
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder="Filter decisions, conventions, files…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}

          <div className={styles.body} aria-live="polite" aria-busy={load.status === "loading" || undefined}>
            {load.status === "idle" || load.status === "loading" ? (
              <div className={styles.loading} role="status">
                <span className="visually-hidden">Loading project memory</span>
                <Skeleton width="78%" />
                <Skeleton width="62%" />
                <Skeleton width="70%" />
              </div>
            ) : load.status === "error" ? (
              <div className={styles.state} data-tone="failed">
                <TriangleAlert aria-hidden="true" />
                <div>
                  <p className={styles.stateTitle}>Memory couldn't load</p>
                  <p className={styles.stateText}>{load.message}</p>
                </div>
                <Button size="sm" icon={<RefreshCw />} onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </Button>
              </div>
            ) : view && view.total === 0 ? (
              <div className={styles.state}>
                <BrainCircuit aria-hidden="true" />
                <div>
                  <p className={styles.stateTitle}>Nothing remembered yet</p>
                  <p className={styles.stateText}>
                    Save a decision or convention once, and you won't have to explain it to the next agent.
                  </p>
                </div>
              </div>
            ) : view && view.shown.length === 0 ? (
              <p className={styles.noMatch}>No notes match “{query.trim()}”.</p>
            ) : view ? (
              <>
                <p className={styles.section}>{view.heading}</p>
                <ul className={styles.list} aria-label="Project memory notes">
                  {view.shown.map((record) => (
                    <li
                      key={record.id}
                      className={styles.note}
                      data-pinned={record.pinned || undefined}
                      data-stale={record.stale || undefined}
                    >
                      <span className={styles.noteIcon} aria-hidden="true">
                        {record.pinned ? <Pin /> : <FileText />}
                      </span>
                      <div className={styles.noteBody}>
                        <p className={styles.noteTitle}>
                          {record.pinned ? <span className="visually-hidden">Pinned: </span> : null}
                          {record.title}
                        </p>
                        <p className={styles.noteText}>{record.content}</p>
                        <p className={styles.noteMeta}>
                          <span>{CATEGORY_LABEL[record.category]}</span>
                          {record.filePath ? <span className={styles.file}>{record.filePath}</span> : null}
                          {record.stale ? <span className={styles.stale}>Needs review</span> : null}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
                {view.more > 0 ? (
                  <p className={styles.more}>
                    {view.more} more {view.more === 1 ? "note" : "notes"} in Unified Memory
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          <footer className={styles.footer}>
            <p className={styles.sharing}>
              {load.status === "ready"
                ? sharingLine(automatic, load.sharing)
                : "Memory belongs to this project, never to one provider."}
              {view && view.stale > 0
                ? ` ${view.stale} ${view.stale === 1 ? "note is" : "notes are"} held back until reviewed.`
                : ""}
            </p>
            <Button ref={openRef} size="sm" variant="primary" icon={<ArrowUpRight />} onClick={openMemory}>
              Open Unified Memory
            </Button>
          </footer>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
