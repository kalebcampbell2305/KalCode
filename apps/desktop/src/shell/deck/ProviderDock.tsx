/**
 * The Provider Dock: every connected Claude, Codex and Gemini account as one compact chip in the
 * Command Deck's status strip — monogram avatar, provider badge, health dot and a ring that fills
 * with the share of the account's threads that are running. A chip's menu moves the open thread
 * onto that account in one choice; dropping a dragged thread on a chip asks first. When the open
 * thread's account is unavailable the dock outlines the accounts that could take it, and never
 * switches anything by itself.
 */
import type { ThreadSummary } from "@kalcode/protocol";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ProviderGlyph,
  Tooltip,
  useToast,
} from "@kalcode/ui/components";
import { ArrowRightLeft, LogIn, Settings2 } from "lucide-react";
import { forwardRef, type Ref, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useThreadSummaries } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { accountFullLabel, accountInlineLabel, accountName } from "../../surfaces/providers/accountIdentity.ts";
import { useOpenProviderAccounts } from "../../surfaces/providers/providersTab.ts";
import { useSelectedThread } from "../../surfaces/threads/accountIntent.ts";
import { RebindThreadDialog } from "../../surfaces/threads/RebindThreadDialog.tsx";
import { describeRebindError, rebindBlocker, threadAccountLabel } from "../../surfaces/threads/useThreadAccount.ts";
import { useDeckData } from "./DeckData.tsx";
import {
  activityShare,
  alternativesFor,
  alternativesHint,
  type Compatibility,
  chipLabel,
  chipParts,
  compatibility,
  type DockAccount,
  dockAccounts,
  isUnavailable,
  usageLine,
} from "./dockModel.ts";
import styles from "./ProviderDock.module.css";
import { onThreadDrop, type ThreadDrag, useThreadDrag } from "./threadDrag.ts";

export function ProviderDock() {
  const { client } = useRuntime();
  const toast = useToast();
  const { accounts } = useDeckData();
  const { state } = useThreadSummaries();
  const threads = state.status === "ready" ? state.data : null;
  const accountList = accounts.data;
  const entries = useMemo(() => (accountList ? dockAccounts(accountList, threads ?? []) : []), [accountList, threads]);
  const selected = useSelectedThread();
  const openThread = threads?.find((thread) => thread.id === selected?.threadId) ?? null;
  const drag = useThreadDrag();
  const alternatives = useMemo(
    () => (openThread && !drag ? alternativesFor(openThread, entries) : []),
    [openThread, drag, entries],
  );
  const suggested = new Set(alternatives.map((entry) => entry.account.id));
  const [dropped, setDropped] = useState<{ thread: ThreadSummary; entry: DockAccount } | null>(null);
  // The dialog keeps its words while it animates closed.
  const lastDropped = useRef(dropped);
  if (dropped) lastDropped.current = dropped;
  const shown = dropped ?? lastDropped.current;
  const [busy, setBusy] = useState(false);
  // The account a thread is being moved onto, until the native answer lands (never optimistic).
  const [moving, setMoving] = useState<string | null>(null);
  const chips = useRef(new Map<string, HTMLButtonElement>());

  const latest = useRef({ entries, toast });
  latest.current = { entries, toast };

  // A drop on a chip opens the Rebind dialog; a drop that can't work says why and changes nothing.
  useEffect(
    () =>
      onThreadDrop((thread, accountId) => {
        const { entries: current, toast: notify } = latest.current;
        const entry = current.find((candidate) => candidate.account.id === accountId);
        if (!entry) return;
        const verdict = compatibility(thread, entry);
        if (verdict.ok) setDropped({ thread, entry });
        else if (verdict.reason !== "current") {
          notify.show({
            tone: "info",
            title: `${chipLabel(entry.account)} can't take “${thread.name}”`,
            description: verdict.detail,
          });
        }
      }),
    [],
  );

  // One rebind at a time across the menu and the drop dialog (a double confirm sends one request).
  const inFlight = useRef(false);
  const rebind = async (thread: ThreadSummary, entry: DockAccount): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    const target = entry.account;
    setMoving(target.id);
    try {
      await client.rebindThreadAccount(thread.id, target.id);
      toast.show({
        tone: "success",
        title: `Moved “${thread.name}” to ${accountInlineLabel(target)}`,
        description: `Future messages use ${accountName(target)}. Past history is unchanged.`,
      });
      return true;
    } catch (error) {
      const failure = describeRebindError(error, {
        target: accountName(target),
        providerName: thread.providerName,
        thread,
      });
      toast.show({ tone: "danger", title: failure.title, description: failure.description });
      return false;
    } finally {
      inFlight.current = false;
      setMoving(null);
    }
  };

  const confirmDrop = async () => {
    if (!dropped || inFlight.current) return;
    setBusy(true);
    await rebind(dropped.thread, dropped.entry);
    setBusy(false);
    setDropped(null);
  };

  if (entries.length === 0) return null;

  const hint = openThread ? alternativesHint(openThread, entries, alternatives) : null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar-like group of account menus, not a form.
    <div className={styles.dock} role="group" aria-label="Provider accounts" data-dragging={drag ? "" : undefined}>
      {entries.map((entry, index) => {
        const previous = entries[index - 1];
        return (
          <DockChip
            key={entry.account.id}
            ref={(node) => {
              if (node) chips.current.set(entry.account.id, node);
              else chips.current.delete(entry.account.id);
            }}
            entry={entry}
            dividerBefore={previous !== undefined && previous.account.providerId !== entry.account.providerId}
            openThread={openThread}
            drag={drag}
            suggested={suggested.has(entry.account.id)}
            moving={moving === entry.account.id}
            onMove={(thread) => void rebind(thread, entry)}
          />
        );
      })}
      {hint ? (
        <span className={styles.hint} role="status">
          {hint}
        </span>
      ) : null}
      {drag ? <DragGhost drag={drag} entries={entries} /> : null}
      <RebindThreadDialog
        open={dropped !== null}
        from={shown ? threadAccountLabel(shown.thread) : ""}
        to={shown ? accountName(shown.entry.account) : ""}
        busy={busy}
        blocker={dropped ? rebindBlocker(dropped.thread) : null}
        signInRequired={false}
        onConfirm={() => void confirmDrop()}
        onCancel={() => setDropped(null)}
        onSignIn={() => setDropped(null)}
        returnFocus={() => (shown ? chips.current.get(shown.entry.account.id)?.focus() : undefined)}
      />
    </div>
  );
}

interface DockChipProps {
  entry: DockAccount;
  dividerBefore: boolean;
  openThread: ThreadSummary | null;
  drag: ThreadDrag | null;
  suggested: boolean;
  /** A thread is being moved onto this account right now. */
  moving: boolean;
  onMove: (thread: ThreadSummary) => void;
}

const DockChip = forwardRef(function DockChip(
  { entry, dividerBefore, openThread, drag, suggested, moving, onMove }: DockChipProps,
  ref: Ref<HTMLButtonElement>,
) {
  const openProviderAccounts = useOpenProviderAccounts();
  const [menuOpen, setMenuOpen] = useState(false);
  const { account } = entry;
  const parts = chipParts(account);
  const usage = usageLine(entry);
  const verdict: Compatibility | null = drag ? compatibility(drag.thread, entry) : null;
  const dropState = verdict ? (verdict.ok ? "ok" : verdict.reason === "current" ? "current" : "no") : undefined;
  const over = drag?.overAccountId === account.id;
  const current = openThread?.providerAccountId === account.id;
  const description = [
    accountFullLabel(account),
    account.providerReportedIdentity?.trim() || null,
    entry.healthLabel,
    usage,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      {dividerBefore ? <span className={styles.divider} aria-hidden="true" /> : null}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip content={verdict && !verdict.ok ? verdict.detail : description} hidden={menuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              ref={ref}
              type="button"
              className={styles.chip}
              data-dock-account={account.id}
              data-health={entry.health}
              data-current={current || undefined}
              data-suggested={suggested || undefined}
              data-drop={dropState}
              data-over={over || undefined}
              data-busy={moving || undefined}
              aria-busy={moving || undefined}
              aria-label={`${accountFullLabel(account)}: ${entry.healthLabel}, ${usage}${current ? ", the open thread's account" : ""}${moving ? ", moving a thread here" : ""}`}
            >
              <Avatar entry={entry} />
              <span className={styles.label}>
                <span className={styles.provider}>{parts.provider} </span>
                <span className={styles.name}>{parts.name}</span>
              </span>
              {moving ? (
                <span className={styles.spinner} aria-hidden="true" />
              ) : entry.running > 0 ? (
                <span className={styles.count}>{entry.running}</span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent minWidth={17} align="start" side="top">
          <DropdownMenuLabel>{accountFullLabel(account)}</DropdownMenuLabel>
          <div className={styles.menuFacts}>
            {account.providerReportedIdentity?.trim() ? (
              <span className={styles.menuIdentity}>{account.providerReportedIdentity.trim()}</span>
            ) : null}
            <span className={styles.menuHealth} data-health={entry.health}>
              <span className={styles.menuDot} aria-hidden="true" />
              {entry.healthLabel}
              {account.isDefault ? " · Default" : ""}
            </span>
            <span className={styles.menuUsage}>{usage}</span>
          </div>
          <DropdownMenuSeparator />
          <MoveItem entry={entry} openThread={openThread} onMove={onMove} />
          {isUnavailable(entry.health) ? (
            <DropdownMenuItem
              icon={<LogIn />}
              onSelect={() => openProviderAccounts({ providerId: account.providerId })}
            >
              Sign in to {accountName(account)}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            icon={<Settings2 />}
            onSelect={() => openProviderAccounts({ providerId: account.providerId })}
          >
            Manage accounts
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
});

/** "Move “thread” here": choosing it is the confirmation, so it spells out what changes. */
function MoveItem({
  entry,
  openThread,
  onMove,
}: {
  entry: DockAccount;
  openThread: ThreadSummary | null;
  onMove: (thread: ThreadSummary) => void;
}) {
  if (!openThread) {
    return <p className={styles.menuNote}>Open a thread to move it here, or drag any thread onto this account.</p>;
  }
  const verdict = compatibility(openThread, entry);
  if (!verdict.ok && verdict.reason === "current") {
    return <p className={styles.menuNote}>“{openThread.name}” uses this account.</p>;
  }
  return (
    <DropdownMenuItem
      icon={<ArrowRightLeft />}
      disabled={!verdict.ok}
      description={
        verdict.ok
          ? `Future messages use ${accountName(entry.account)}. Its current session ends; history stays.`
          : verdict.detail
      }
      onSelect={() => onMove(openThread)}
    >
      Move “{openThread.name}” here
    </DropdownMenuItem>
  );
}

const RING_R = 10.5;
const RING_C = 2 * Math.PI * RING_R;

function Avatar({ entry }: { entry: DockAccount }) {
  const share = activityShare(entry);
  return (
    <span className={styles.avatar} data-hue={entry.hue} aria-hidden="true">
      <svg className={styles.ring} viewBox="0 0 24 24" aria-hidden="true" data-live={entry.running > 0 || undefined}>
        <circle className={styles.ringTrack} cx="12" cy="12" r={RING_R} />
        {share > 0 ? (
          <circle
            className={styles.ringFill}
            cx="12"
            cy="12"
            r={RING_R}
            strokeDasharray={`${RING_C * share} ${RING_C}`}
            transform="rotate(-90 12 12)"
          />
        ) : null}
      </svg>
      <span className={styles.monogram}>{entry.monogram}</span>
      <span className={styles.badge}>
        <ProviderGlyph provider={entry.account.providerId} size="xs" />
      </span>
      <span className={styles.health} data-health={entry.health} />
    </span>
  );
}

/** The thread under the pointer while it is dragged, and where it would go. */
function DragGhost({ drag, entries }: { drag: ThreadDrag; entries: DockAccount[] }) {
  const target = entries.find((entry) => entry.account.id === drag.overAccountId) ?? null;
  const verdict = target ? compatibility(drag.thread, target) : null;
  const caption = !target
    ? "Drop on an account"
    : verdict?.ok
      ? `Move to ${chipLabel(target.account)}`
      : (verdict?.detail ?? "");
  return createPortal(
    <div
      className={styles.ghost}
      style={{ transform: `translate(${drag.x + 12}px, calc(${drag.y - 10}px - 100%))` }}
      data-drop={verdict ? (verdict.ok ? "ok" : "no") : undefined}
      aria-hidden="true"
    >
      <ProviderGlyph provider={drag.thread.providerId} size="xs" />
      <span className={styles.ghostName}>{drag.thread.name}</span>
      <span className={styles.ghostCaption}>{caption}</span>
    </div>,
    document.body,
  );
}
