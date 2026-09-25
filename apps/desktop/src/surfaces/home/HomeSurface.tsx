import type { HomeSummary, RecentWorkItem, RecentWorkWhen, WorkspaceRailEntry } from "@kalcode/protocol";
import { displayStatusOf } from "@kalcode/protocol";
import {
  Button,
  ErrorState,
  Kbd,
  Panel,
  ProviderGlyph,
  ProviderMark,
  Skeleton,
  StatusChip,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@kalcode/ui/components";
import {
  ArrowRight,
  CircleCheck,
  Clock3,
  FileText,
  FolderClosed,
  FolderOpen,
  History,
  MessageSquarePlus,
  PlayCircle,
  PlugZap,
  Search,
  ShieldAlert,
  Sparkles,
  UserRound,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type KalCodeError, toKalCodeError } from "../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useUiIntents } from "../../runtime/uiIntents.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { badgeLabel, relativeTime } from "../../shell/rail/model.ts";
import { useOptionalRail } from "../../shell/rail/RailProvider.tsx";
import { useOptionalSearch } from "../../shell/rail/search/SearchProvider.tsx";
import { ScopedHeading, useSurfaceScope } from "../../shell/rail/surfaceScope.tsx";
import { MOD_LABEL } from "../../shell/shortcuts.ts";
import { useThreadsIntent } from "../threads/intent.tsx";
import styles from "./Home.module.css";
import { dateEyebrow, summaryLine } from "./homeModel.ts";

/** Events after which the summary may have changed (refreshed, greeting kept). */
const RELEVANT = /^(thread\.|approval\.|workspace\.|settings\.changed)/;

/**
 * The returning-user home (Z7-W2): a greeting by the Settings display name, then what needs
 * you, what's running, what finished since your last visit, where to pick up, your recent
 * workspaces and recent work — all from real state. A first run says so and shows next steps.
 * Also shown in a pane (`kalcode.home`): there it never counts as a visit (no new greeting).
 */
export function HomeSurface() {
  const { client } = useRuntime();
  const scope = useSurfaceScope();
  const { events } = useEvents();
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [error, setError] = useState<KalCodeError | null>(null);
  const request = useRef(0);

  const load = useCallback(
    async (visit: boolean) => {
      const id = ++request.current;
      try {
        const next = await client.homeSummary(visit);
        if (id === request.current) {
          setSummary(next);
          setError(null);
        }
      } catch (cause) {
        if (id === request.current) setError(toKalCodeError(cause));
      }
    },
    [client],
  );

  // One visit per mount: a remount in development StrictMode refreshes without a new greeting.
  const visited = useRef(scope.inPane);
  useEffect(() => {
    void load(!visited.current);
    visited.current = true;
  }, [load]);

  const newest = events[0]?.seq ?? 0;
  const seen = useRef(newest);
  useEffect(() => {
    const fresh = events.filter((e) => e.seq > seen.current);
    seen.current = Math.max(seen.current, newest);
    if (!fresh.some((e) => RELEVANT.test(e.type))) return;
    const timer = setTimeout(() => void load(false), 400);
    return () => clearTimeout(timer);
  }, [events, newest, load]);

  if (error && !summary) {
    return (
      <div className={styles.home} data-in-pane={scope.inPane || undefined}>
        <ErrorState
          headingLevel={scope.level(1)}
          title="Home couldn't load"
          code={error.code}
          actions={
            <Button variant="secondary" onClick={() => void load(true)}>
              Try again
            </Button>
          }
        >
          {error.message}
        </ErrorState>
      </div>
    );
  }
  if (!summary) {
    return (
      <div className={styles.home} data-in-pane={scope.inPane || undefined} aria-busy="true">
        <header className={styles.hero}>
          <Skeleton width="12rem" />
          <Skeleton width="24rem" height="2rem" />
          <Skeleton width="18rem" />
        </header>
      </div>
    );
  }
  return summary.firstRun ? <FirstRun summary={summary} /> : <Returning summary={summary} />;
}

function Hero({ summary }: { summary: HomeSummary }) {
  const workspaces = useWorkspaces();
  const { navigate } = useNavigation();
  const threadsIntent = useThreadsIntent();
  const search = useOptionalSearch();
  const rail = useOptionalRail();
  return (
    <header className={styles.hero}>
      <p className={styles.eyebrow}>{dateEyebrow()}</p>
      <ScopedHeading level={1} className={styles.greeting}>
        {summary.greeting}
      </ScopedHeading>
      <p className={styles.summary}>{summaryLine(summary)}</p>
      <div className={styles.heroActions}>
        {summary.firstRun ? null : (
          <Button
            variant="primary"
            icon={<MessageSquarePlus />}
            onClick={() => {
              navigate("threads");
              threadsIntent.request("new");
            }}
          >
            New thread
          </Button>
        )}
        <Button
          variant={summary.firstRun ? "primary" : "secondary"}
          icon={<FolderOpen />}
          onClick={async () => {
            const opened = await workspaces.openFolder();
            if (opened && rail) await rail.openWorkspace(opened.id);
          }}
        >
          Open folder
        </Button>
        {search ? (
          <Button variant="ghost" icon={<Search />} onClick={() => search.setOpen(true)}>
            Search <Kbd>{`${MOD_LABEL} K`}</Kbd>
          </Button>
        ) : null}
      </div>
    </header>
  );
}

function FirstRun({ summary }: { summary: HomeSummary }) {
  const scope = useSurfaceScope();
  const { navigate } = useNavigation();
  const threadsIntent = useThreadsIntent();
  const workspaces = useWorkspaces();
  const rail = useOptionalRail();
  const hasWorkspace = summary.workspaceCount > 0;
  return (
    <div className={styles.home} data-first-run data-in-pane={scope.inPane || undefined}>
      <Hero summary={summary} />
      <ol className={styles.steps} aria-label="Get started">
        <li className={styles.step} data-done={hasWorkspace || undefined}>
          <span className={styles.stepIcon} aria-hidden="true">
            {hasWorkspace ? <CircleCheck /> : <FolderOpen />}
          </span>
          <div className={styles.stepText}>
            <ScopedHeading level={2} className={styles.stepTitle}>
              Open a project folder
            </ScopedHeading>
            <p>A workspace is a folder on this computer. Its threads, terminals and files gather in one place.</p>
          </div>
          <Button
            variant={hasWorkspace ? "ghost" : "secondary"}
            size="sm"
            onClick={async () => {
              const opened = await workspaces.openFolder();
              if (opened && rail) await rail.openWorkspace(opened.id);
            }}
          >
            {hasWorkspace ? "Open another" : "Open folder"}
          </Button>
        </li>
        <li className={styles.step}>
          <span className={styles.stepIcon} aria-hidden="true">
            <PlugZap />
          </span>
          <div className={styles.stepText}>
            <ScopedHeading level={2} className={styles.stepTitle}>
              Connect a provider
            </ScopedHeading>
            <p>KalCode runs the provider CLIs you already use, with your own sign-in. See which are ready.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => navigate("providers")}>
            Check providers
          </Button>
        </li>
        <li className={styles.step}>
          <span className={styles.stepIcon} aria-hidden="true">
            <Zap />
          </span>
          <div className={styles.stepText}>
            <ScopedHeading level={2} className={styles.stepTitle}>
              Start a thread
            </ScopedHeading>
            <p>Give an agent a task in your workspace. You approve what it may do.</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              navigate("threads");
              threadsIntent.request("new");
            }}
          >
            New thread
          </Button>
        </li>
      </ol>
      <p className={styles.previewLabel}>Once you're working</p>
      <ul className={styles.preview} aria-label="What Home shows once you're working">
        <li className={styles.previewWell}>
          <p className={styles.previewTitle}>
            <ShieldAlert aria-hidden="true" />
            Needs you
          </p>
          <p>Threads waiting for your approval or your reply, and anything that failed.</p>
        </li>
        <li className={styles.previewWell}>
          <p className={styles.previewTitle}>
            <Sparkles aria-hidden="true" />
            Running now
          </p>
          <p>Every thread at work, in every workspace, with its provider and status.</p>
        </li>
        <li className={styles.previewWell}>
          <p className={styles.previewTitle}>
            <History aria-hidden="true" />
            Where you left off
          </p>
          <p>What finished since your last visit, what you can resume, and your recent work by day.</p>
        </li>
      </ul>
      {summary.displayName ? null : <NameHint />}
    </div>
  );
}

function NameHint() {
  const { navigate } = useNavigation();
  return (
    <p className={styles.nameHint}>
      <UserRound aria-hidden="true" />
      Want to be greeted by name? Set a display name in{" "}
      <button type="button" className={styles.link} onClick={() => navigate("settings")}>
        Settings
      </button>
      {". It stays on this computer."}
    </p>
  );
}

function Returning({ summary }: { summary: HomeSummary }) {
  const scope = useSurfaceScope();
  const pickUp = mergeUnique(
    summary.resumable,
    summary.lastSession.filter((i) => i.kind === "thread"),
  ).slice(0, 6);
  const lastWorkspaces = summary.lastSession.filter((i) => i.kind === "workspace");
  return (
    <div className={styles.home} data-in-pane={scope.inPane || undefined}>
      <Hero summary={summary} />
      <div className={styles.grid}>
        <div className={styles.live}>
          {summary.needsYouCount + summary.runningCount + summary.finishedSinceLastVisit.length === 0 ? (
            <AllClear />
          ) : (
            <>
              <ItemsPanel
                id="home-needs-you"
                title="Needs you"
                icon={<ShieldAlert />}
                count={summary.needsYouCount}
                countTone="attention"
                items={summary.needsYou}
                empty="Nothing is waiting for you."
                tone={summary.needsYouCount > 0 ? "lit" : "default"}
              />
              <ItemsPanel
                id="home-running"
                title="Running now"
                icon={<Sparkles />}
                count={summary.runningCount}
                items={summary.running}
                empty="Nothing is running right now."
              />
              <ItemsPanel
                id="home-finished"
                title="Finished since your last visit"
                icon={<CircleCheck />}
                count={summary.finishedSinceLastVisit.length}
                items={summary.finishedSinceLastVisit}
                empty="Nothing finished since your last visit."
              />
            </>
          )}
        </div>
        <div className={styles.side}>
          <RecentWorkspaces entries={summary.recentWorkspaces} />
          <ItemsPanel
            id="home-pick-up"
            title="Pick up where you left off"
            icon={<History />}
            count={pickUp.length}
            items={pickUp}
            empty={
              lastWorkspaces.length > 0
                ? `Last time you worked in ${lastWorkspaces.map((w) => w.title).join(", ")}.`
                : "Nothing from your last session to resume."
            }
            showResume
          />
        </div>
        <RecentWork />
      </div>
      {summary.displayName ? null : <NameHint />}
    </div>
  );
}

/** Nothing running, waiting or newly finished: one calm panel instead of three empty ones. */
function AllClear() {
  const scope = useSurfaceScope();
  const { navigate } = useNavigation();
  const threadsIntent = useThreadsIntent();
  return (
    <Panel
      id={scope.id("home-right-now")}
      title="Right now"
      headingLevel={scope.level(2)}
      icon={<CircleCheck />}
      padding="md"
    >
      <div className={styles.allClear}>
        <p className={styles.allClearTitle}>All clear.</p>
        <p className={styles.allClearText}>
          Nothing is running, nothing needs you, and nothing finished since your last visit.
        </p>
        <Button
          size="sm"
          variant="secondary"
          icon={<MessageSquarePlus />}
          onClick={() => {
            navigate("threads");
            threadsIntent.request("new");
          }}
        >
          Start a thread
        </Button>
      </div>
    </Panel>
  );
}

function mergeUnique(first: RecentWorkItem[], second: RecentWorkItem[]): RecentWorkItem[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((item) => {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Threads and workspaces open through the shared focus intent (the pane system can claim them). */
function useOpenItem() {
  const intents = useUiIntents();
  return (item: RecentWorkItem) => {
    if (item.kind === "thread") {
      void intents.focus({ kind: "thread", threadId: item.id, workspaceId: item.workspaceId });
    } else if (item.workspaceId) {
      void intents.focus({ kind: "workspace", workspaceId: item.workspaceId });
    }
  };
}

function ItemsPanel({
  id,
  title,
  icon,
  count,
  countTone,
  items,
  empty,
  tone = "default",
  showResume = false,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  count: number;
  countTone?: "neutral" | "attention";
  items: RecentWorkItem[];
  empty: string;
  tone?: "default" | "lit";
  showResume?: boolean;
}) {
  const open = useOpenItem();
  const scope = useSurfaceScope();
  const now = Date.now();
  return (
    <Panel
      id={scope.id(id)}
      title={title}
      headingLevel={scope.level(2)}
      icon={icon}
      count={count}
      countTone={countTone ?? "neutral"}
      tone={tone}
      padding="none"
    >
      {items.length === 0 ? (
        <p className={styles.panelEmpty}>{empty}</p>
      ) : (
        <ul className={styles.items} aria-label={title}>
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <button type="button" className={styles.item} onClick={() => open(item)}>
                <ItemLead item={item} />
                <span className={styles.itemText}>
                  <span className={styles.itemTitle}>{item.title}</span>
                  <span className={styles.itemMeta}>
                    {item.providerName ? <span>{item.providerName}</span> : null}
                    {item.workspaceName ? <span>{item.workspaceName}</span> : null}
                  </span>
                </span>
                {item.status ? (
                  <StatusChip
                    status={displayStatusOf(item.status).status}
                    qualifier={displayStatusOf(item.status).qualifier}
                    variant="inline"
                    size="sm"
                  />
                ) : null}
                <span className={styles.time}>
                  <Clock3 aria-hidden="true" />
                  {relativeTime(item.lastActivityAt, now)}
                </span>
                {showResume && item.kind === "thread" ? (
                  <span className={styles.resume} aria-hidden="true">
                    <PlayCircle />
                  </span>
                ) : (
                  <ArrowRight className={styles.go} aria-hidden="true" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ItemLead({ item }: { item: RecentWorkItem }) {
  if (item.kind === "thread" && item.providerId) {
    return <ProviderGlyph provider={item.providerId} size="sm" />;
  }
  return (
    <span className={styles.kindIcon} aria-hidden="true">
      {item.kind === "file" ? <FileText /> : <FolderClosed />}
    </span>
  );
}

function RecentWorkspaces({ entries }: { entries: WorkspaceRailEntry[] }) {
  const intents = useUiIntents();
  const scope = useSurfaceScope();
  const continueIn = (entry: WorkspaceRailEntry) => {
    void intents.focus({ kind: "workspace", workspaceId: entry.workspaceId });
  };
  const now = Date.now();
  return (
    <Panel
      id={scope.id("home-workspaces")}
      title="Recent workspaces"
      headingLevel={scope.level(2)}
      icon={<FolderClosed />}
      count={entries.length}
      padding="none"
    >
      {entries.length === 0 ? (
        <p className={styles.panelEmpty}>No workspaces yet. Open a folder to add one.</p>
      ) : (
        <ul className={styles.workspaces} aria-label="Recent workspaces">
          {entries.map((entry) => (
            <li key={entry.workspaceId} className={styles.workspace} data-active={entry.active || undefined}>
              <div className={styles.workspaceHead}>
                <span className={styles.workspaceName}>{entry.name}</span>
                {entry.pinned ? <span className={styles.pinned}>Pinned</span> : null}
                {entry.available ? null : <span className={styles.missing}>Folder missing</span>}
              </div>
              <span className={styles.workspacePath}>{entry.displayPath}</span>
              <div className={styles.workspaceFoot}>
                <span className={styles.providers} aria-hidden={entry.providers.length === 0 || undefined}>
                  {entry.providers.slice(0, 3).map((p) => (
                    <ProviderMark key={p.providerId} provider={p.providerId} name={p.providerName} size="xs" hideName />
                  ))}
                </span>
                <span className={styles.workspaceMeta}>
                  {badgeLabel(entry) || "No threads yet"} · {relativeTime(entry.lastActivityAt, now)}
                </span>
                <Button
                  size="sm"
                  variant={entry.active ? "primary" : "secondary"}
                  disabled={!entry.available}
                  onClick={() => continueIn(entry)}
                  aria-label={`Continue in ${entry.name}`}
                >
                  Continue
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const WHEN: { id: RecentWorkWhen; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this_week", label: "This week" },
];

/** Recent work by day, from the event log ("what was I working on yesterday?"). */
function RecentWork() {
  const { client } = useRuntime();
  const [when, setWhen] = useState<RecentWorkWhen>("today");
  const [items, setItems] = useState<Record<string, RecentWorkItem[] | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const open = useOpenItem();
  const scope = useSurfaceScope();
  useEffect(() => {
    let live = true;
    client
      .recentWork(when, 30)
      .then((page) => {
        if (live) setItems((current) => ({ ...current, [when]: page.items }));
      })
      .catch((cause) => {
        if (live) setError(toKalCodeError(cause).message);
      });
    return () => {
      live = false;
    };
  }, [client, when]);
  const list = items[when];
  const now = Date.now();
  return (
    <Panel
      id={scope.id("home-recent-work")}
      title="Recent work"
      headingLevel={scope.level(2)}
      icon={<History />}
      padding="none"
      className={styles.recentWork}
    >
      <Tabs value={when} onValueChange={(v) => setWhen(v as RecentWorkWhen)}>
        <TabsList variant="line" aria-label="When" className={styles.tabs}>
          {WHEN.map((w) => (
            <TabsTrigger key={w.id} value={w.id}>
              {w.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {WHEN.map((w) => (
          <TabsContent key={w.id} value={w.id}>
            {error ? (
              <p className={styles.panelEmpty} role="alert">
                {error}
              </p>
            ) : !list ? (
              <div className={styles.panelEmpty}>
                <Skeleton width="60%" />
              </div>
            ) : list.length === 0 ? (
              <p className={styles.panelEmpty}>
                {w.id === "today"
                  ? "Nothing recorded today yet."
                  : w.id === "yesterday"
                    ? "Nothing was recorded yesterday."
                    : "Nothing recorded this week."}
              </p>
            ) : (
              <ul className={styles.work} aria-label={`Recent work, ${w.label.toLowerCase()}`}>
                {list.map((item) => (
                  <li key={`${item.kind}:${item.id}`}>
                    <button type="button" className={styles.workItem} onClick={() => open(item)}>
                      <ItemLead item={item} />
                      <span className={styles.itemText}>
                        <span className={item.kind === "file" ? styles.fileTitle : styles.itemTitle}>{item.title}</span>
                        <span className={styles.itemMeta}>
                          <span>{item.kind === "thread" ? "Thread" : item.kind === "file" ? "File" : "Workspace"}</span>
                          {item.workspaceName && item.kind !== "workspace" ? <span>{item.workspaceName}</span> : null}
                        </span>
                      </span>
                      {item.status ? (
                        <StatusChip status={displayStatusOf(item.status).status} variant="dot" size="sm" />
                      ) : null}
                      <span className={styles.time}>{relativeTime(item.lastActivityAt, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </Panel>
  );
}
