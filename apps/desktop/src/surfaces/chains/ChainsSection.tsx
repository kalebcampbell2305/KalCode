import type { Chain, ChainStep } from "@kalcode/protocol";
import { Button } from "@kalcode/ui/components";
import { ChevronRight, Link2, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { clearFocusedChain, focusChain, useFocusedChain } from "../../runtime/chains/focus.ts";
import { useOptionalChains } from "../../runtime/chains/useChains.tsx";
import { useOptionalUiIntents } from "../../runtime/uiIntents.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { ChainCard } from "./ChainCard.tsx";
import { ChainComposerDialog, useChainsIncluded } from "./ChainComposerDialog.tsx";
import styles from "./ChainsSection.module.css";
import { consumeChainComposer, useChainComposerRequest } from "./composerIntent.ts";
import { CHAIN_PHASE_META, inChainHistory } from "./model.ts";

/** How long a focused chain keeps its arrival highlight. */
const HIGHLIGHT_MS = 1_600;

function newestFirst(a: Chain, b: Chain): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/** "2 running · 1 needs you" from the live chains (never a guess). */
function summaryLine(chains: readonly Chain[]): string {
  const counts = new Map<string, number>();
  for (const chain of chains) counts.set(chain.phase, (counts.get(chain.phase) ?? 0) + 1);
  const order = ["needs_you", "blocked", "running", "paused", "ready_to_merge"] as const;
  return order
    .filter((phase) => counts.has(phase))
    .map((phase) => `${counts.get(phase)} ${CHAIN_PHASE_META[phase].label.toLowerCase()}`)
    .join(" · ");
}

/**
 * Activity's Chains: every live handoff chain with its rail (newest first), settled ones folded
 * into a short history, and the way to start one. `focusChain(id)` scrolls to and highlights a
 * chain; a "New handoff chain" request opens the composer.
 */
export function ChainsSection() {
  const chains = useOptionalChains();
  const included = useChainsIncluded();
  const focus = useFocusedChain();
  const request = useChainComposerRequest();
  const uiIntents = useOptionalUiIntents();
  const { active: workspace } = useWorkspaces();
  const [composerOpen, setComposerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    setComposerOpen(true);
    consumeChainComposer(request.nonce);
  }, [request]);

  const all = chains?.chains;
  const { live, history } = useMemo(() => {
    const list = [...(all ?? [])].sort(newestFirst);
    return { live: list.filter((chain) => !inChainHistory(chain)), history: list.filter(inChainHistory) };
  }, [all]);

  // Bring a focused chain into view once it is known, then let the highlight settle.
  useEffect(() => {
    if (!focus || !all) return;
    const target = all.find((chain) => chain.id === focus.chainId);
    if (!target) return;
    if (inChainHistory(target)) setHistoryOpen(true);
    setHighlighted(target.id);
    clearFocusedChain();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const card = document.querySelector<HTMLElement>(`[data-chain-card="${CSS.escape(target.id)}"]`);
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        card?.scrollIntoView?.({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
      }),
    );
  }, [focus, all]);
  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  const openAgent = useCallback(
    (chain: Chain, step: ChainStep) => {
      const threadId = chains?.operationsById.get(step.operationId)?.threadId ?? step.operationId;
      void uiIntents?.focus({ kind: "agent", agentId: threadId, workspaceId: chain.workspaceId });
    },
    [chains?.operationsById, uiIntents],
  );

  const composer = (
    <ChainComposerDialog
      open={composerOpen}
      workspaceId={workspace?.available === false ? null : (workspace?.id ?? null)}
      workspaceName={workspace?.name ?? null}
      onClose={() => setComposerOpen(false)}
      onStarted={(chain) => {
        setComposerOpen(false);
        focusChain(chain.id);
      }}
    />
  );

  if (!chains || (chains.loading && chains.snapshot === null)) return composerOpen ? composer : null;

  if (chains.snapshot === null && chains.error) {
    return (
      <section className={styles.problem} aria-label="Handoff chains">
        <span>Chains are unavailable: {chains.error.message}</span>
        <Button size="sm" variant="secondary" icon={<RefreshCw />} onClick={() => void chains.refresh()}>
          Try again
        </Button>
        {composer}
      </section>
    );
  }

  if (live.length === 0 && history.length === 0) {
    // No permanent upsell: a plan without chains shows nothing until one exists.
    if (!included) return composerOpen ? composer : null;
    return (
      <section className={styles.empty} aria-labelledby="activity-chains-empty">
        <span className={styles.emptyGlyph} aria-hidden="true">
          <Link2 />
        </span>
        <h2 id="activity-chains-empty" className={styles.emptyTitle}>
          Handoff chains
        </h2>
        <p className={styles.emptyText}>
          Pass one task through Implement → Review → Fix → Test without re-explaining it.
        </p>
        <Button size="sm" variant="secondary" icon={<Plus />} onClick={() => setComposerOpen(true)}>
          New handoff chain
        </Button>
        {composer}
      </section>
    );
  }

  return (
    <section className={styles.section} aria-labelledby="activity-chains" data-activity-chains>
      <header className={styles.head}>
        <h2 id="activity-chains" className={styles.title}>
          Chains
        </h2>
        <p className={styles.summary}>{live.length > 0 ? summaryLine(live) : "Nothing running"}</p>
        <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setComposerOpen(true)}>
          New handoff chain
        </Button>
      </header>
      {live.length > 0 ? (
        <div className={styles.list}>
          {live.map((chain) => (
            <ChainCard
              key={chain.id}
              chain={chain}
              operationsById={chains.operationsById}
              controls={chains}
              onOpenAgent={openAgent}
              highlighted={highlighted === chain.id}
            />
          ))}
        </div>
      ) : null}
      {history.length > 0 ? (
        <div className={styles.history}>
          <button
            type="button"
            className={styles.historyToggle}
            aria-expanded={historyOpen}
            aria-controls="activity-chains-history"
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <ChevronRight className={styles.historyChevron} aria-hidden="true" />
            History
            <span className={styles.historyCount}>{history.length}</span>
            {historyOpen ? null : (
              <span className={styles.historyNames}>{history.map((chain) => chain.name).join(" · ")}</span>
            )}
          </button>
          {historyOpen ? (
            <div id="activity-chains-history" className={styles.list}>
              {history.map((chain) => (
                <ChainCard
                  key={chain.id}
                  chain={chain}
                  operationsById={chains.operationsById}
                  controls={chains}
                  onOpenAgent={openAgent}
                  highlighted={highlighted === chain.id}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {composer}
    </section>
  );
}
