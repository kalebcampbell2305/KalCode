import { Button, EmptyState } from "@kalcode/ui/components";
import { MessagesSquare, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useThreadsIntent } from "./intent.tsx";
import { NewThread } from "./NewThread.tsx";
import { ThreadDetail } from "./ThreadDetail.tsx";
import { ThreadList } from "./ThreadList.tsx";
import styles from "./ThreadsSurface.module.css";
import { useThreadList } from "./useThreads.ts";

type Pane = { kind: "detail"; threadId: string | null } | { kind: "new" };

export function ThreadsSurface() {
  const { intent } = useThreadsIntent();
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [pane, setPane] = useState<Pane>({ kind: "detail", threadId: null });
  const list = useThreadList(showArchived);
  const searchRef = useRef<HTMLInputElement>(null);
  const autoSelected = useRef(false);

  // Open the most recent thread the first time the list loads.
  useEffect(() => {
    if (autoSelected.current || list.state !== "ready") return;
    autoSelected.current = true;
    const first = list.entries.find((entry) => !entry.archived);
    if (first)
      setPane((current) =>
        current.kind === "detail" && !current.threadId ? { kind: "detail", threadId: first.thread.id } : current,
      );
  }, [list.state, list.entries]);

  // Command palette requests ("New thread", "Search threads") and KalVoice ("open thread …").
  const handledNonce = useRef(0);
  useEffect(() => {
    if (!intent || intent.nonce === handledNonce.current) return;
    handledNonce.current = intent.nonce;
    if (intent.kind === "new") setPane({ kind: "new" });
    else if (intent.kind === "open" && intent.threadId) setPane({ kind: "detail", threadId: intent.threadId });
    else requestAnimationFrame(() => searchRef.current?.focus());
  }, [intent]);

  const selectedId = pane.kind === "detail" ? pane.threadId : null;
  const selectedEntry = list.entries.find((entry) => entry.thread.id === selectedId) ?? null;
  const hasThreads = list.entries.length > 0;

  return (
    <div className={styles.surface}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1 className={styles.title}>Threads</h1>
          <p className={styles.description}>One provider, one workspace, the permissions you choose.</p>
        </div>
        <Button
          variant="primary"
          icon={<Plus />}
          onClick={() => setPane({ kind: "new" })}
          disabled={pane.kind === "new"}
        >
          New thread
        </Button>
      </header>
      <div className={styles.body}>
        <ThreadList
          list={list}
          query={query}
          onQueryChange={setQuery}
          showArchived={showArchived}
          onShowArchivedChange={setShowArchived}
          selectedId={selectedId}
          onSelect={(threadId) => setPane({ kind: "detail", threadId })}
          searchRef={searchRef}
        />
        <section className={styles.detailPane} aria-label={pane.kind === "new" ? "New thread" : "Thread"}>
          {pane.kind === "new" ? (
            <NewThread
              onCreated={(thread) => {
                void list.reload();
                setPane({ kind: "detail", threadId: thread.id });
              }}
              onCancel={() => setPane({ kind: "detail", threadId: selectedId ?? list.entries[0]?.thread.id ?? null })}
            />
          ) : selectedId ? (
            <ThreadDetail
              key={selectedId}
              threadId={selectedId}
              archived={selectedEntry?.archived ?? false}
              onArchived={() => {
                void list.reload();
              }}
            />
          ) : list.state === "loading" ? null : (
            <div className={styles.placeholder}>
              {hasThreads ? (
                <p className={styles.hint}>Select a thread to see its conversation and tool activity.</p>
              ) : (
                <EmptyState
                  headingLevel={2}
                  art={<MessagesSquare />}
                  title="No threads yet"
                  actions={
                    <Button variant="primary" icon={<Plus />} onClick={() => setPane({ kind: "new" })}>
                      New thread
                    </Button>
                  }
                >
                  <p>
                    A thread gives Claude Code a task in one of your workspaces. You'll see what it's doing, the tools
                    it runs and anything waiting for your approval.
                  </p>
                </EmptyState>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
