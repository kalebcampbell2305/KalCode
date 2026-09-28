import type { ProviderAccount, SettingsPatch, SurfaceId } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { Command } from "cmdk";
import {
  ArrowRightLeft,
  AudioLines,
  ChevronsDownUp,
  ClipboardCopy,
  Columns2,
  Equal,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  FolderTree,
  GitCommitHorizontal,
  House,
  KeyRound,
  LayoutGrid,
  Maximize2,
  MessageSquarePlus,
  Monitor,
  Moon,
  PanelLeft,
  PanelsLeftBottom,
  Rows2,
  Rows3,
  Search,
  SquareTerminal,
  Sun,
  Undo2,
  UserRoundCheck,
  UserRoundCog,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toKalCodeError } from "../ipc/errors.ts";
import { useOptionalKalVoice } from "../kalvoice/KalVoiceProvider.tsx";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../runtime/WorkspaceProvider.tsx";
import { CODE_SHORTCUT_LABELS } from "../surfaces/code/shortcuts.ts";
import { requestProvidersTab } from "../surfaces/providers/providersTab.ts";
import { useDiagnosticsActions } from "../surfaces/settings/useDiagnosticsActions.ts";
import { requestRebind, useSelectedThread } from "../surfaces/threads/accountIntent.ts";
import { useThreadsIntent } from "../surfaces/threads/intent.tsx";
import { accountKeywords, accountProviderName, matchAccounts, parseAccountCommand } from "./accountCommands.ts";
import styles from "./CommandPalette.module.css";
import { PRIMARY_ORDER, SURFACES, useNavigation, VIEWS, viewVisible } from "./navigation.tsx";
import { dispatchPaneCommand, type PaneCommand } from "./panes/paneCommands.ts";
import { PANE_SHORTCUT_LABELS } from "./panes/paneShortcuts.ts";
import { useOpenInPane } from "./panes/useOpenInPane.ts";
import { HOME_WIDGET, PROJECT_WIDGET, WORKSPACES_WIDGET } from "./rail/paneIds.ts";
import { useOptionalRail } from "./rail/RailProvider.tsx";
import { LocatorFilterBar, LocatorResultItems } from "./rail/search/LocatorResults.tsx";
import { useSearch } from "./rail/search/SearchProvider.tsx";
import { useLocatorSearch } from "./rail/search/useLocatorSearch.ts";
import { useOpenLocated } from "./rail/search/useOpenLocated.ts";
import { RAIL_SHORTCUT } from "./rail/WorkspaceRail.tsx";
import { MOD_LABEL } from "./shortcuts.ts";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function namedCommand(root: HTMLElement, typed: string): HTMLElement | undefined {
  const commandItems = [...root.querySelectorAll<HTMLElement>("[cmdk-item]")].filter(
    (el) => !el.dataset.value?.startsWith("locator:"),
  );
  const normalized = (item: HTMLElement) => item.dataset.value?.toLowerCase() ?? "";
  return (
    commandItems.find((item) => normalized(item) === typed) ??
    commandItems.find((item) => normalized(item).startsWith(typed)) ??
    commandItems.find((item) => normalized(item).includes(typed))
  );
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const { client, info, settings, updateSettings } = useRuntime();
  const toast = useToast();
  const { navigate } = useNavigation();
  const diagnostics = useDiagnosticsActions();
  const kalvoice = useOptionalKalVoice();
  const workspaces = useWorkspaces();
  const threadsIntent = useThreadsIntent();
  // Z7-W2: typed text also searches the Session Locator (threads, workspaces, terminals, …) when
  // the build shows it; gated features stay unreachable on Stable.
  const featureVisible = (id: string) => info.flags.features?.some((f) => f.id === id && f.visible) ?? false;
  const locatorVisible = featureVisible("session_locator");
  const search = useSearch();
  const rail = useOptionalRail();
  const locator = useLocatorSearch(search.query, {
    kinds: search.kinds,
    limit: 12,
    enabled: open && locatorVisible,
  });
  const openLocated = useOpenLocated();
  const openInPane = useOpenInPane();
  const searching = locatorVisible && search.query.trim() !== "";
  // Results for older text are held back while the new answer is on its way, so they never take
  // the selection the command list gives the text now.
  const current = searching && locator.forText === search.query.trim();
  const located = current ? (locator.response?.results.items.length ?? 0) : 0;
  // The best locator match is selected when results arrive (Enter opens it) — unless the text
  // names a command ("Open folder"), which keeps Enter.
  const [selected, setSelected] = useState("");
  const commandRoot = useRef<HTMLDivElement>(null);
  const navigatedQuery = useRef<string | null>(null);
  const first = current ? locator.response?.results.items[0] : undefined;
  const firstValue = first ? `locator:${first.kind}:${first.entityId}` : "";
  const typed = search.query.trim().toLowerCase();
  useEffect(() => {
    if (!open || navigatedQuery.current !== typed) navigatedQuery.current = null;
  }, [open, typed]);
  useEffect(() => {
    if (!open || !typed) return;
    // cmdk fuzzy-ranks commands and registers async locator items in layout effects. Select after
    // those updates so an explicitly named command wins over a weaker fuzzy or locator match.
    const frame = window.requestAnimationFrame(() => {
      const root = commandRoot.current;
      if (!root || navigatedQuery.current === typed) return;
      const preferred =
        namedCommand(root, typed) ??
        [...root.querySelectorAll<HTMLElement>("[cmdk-item]")].find((item) => item.dataset.value === firstValue);
      if (preferred) setSelected(preferred.dataset.value ?? "");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [firstValue, open, typed]);

  const run = (action: () => unknown) => () => {
    onOpenChange(false);
    void action();
  };
  const set = (patch: SettingsPatch) => run(() => updateSettings(patch));
  // Pane commands (Z7-W1) run on the Code canvas; they wait for it when Code isn't on screen.
  const pane = (command: PaneCommand) =>
    run(() => {
      navigate("code");
      dispatchPaneCommand(command, { queue: true });
    });

  const visible = new Set(info.flags.surfaces.filter((f) => f.visible).map((f) => f.id));

  // 0.1.5 account commands ("switch gemini b", "use codex work"). Accounts are read when the
  // palette opens; a thread rebind only asks the Rebind dialog, a workspace default is confirmed.
  const selectedThread = useSelectedThread();
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    client
      .listProviderAccounts()
      .then((listed) => live && setAccounts(listed))
      .catch(() => live && setAccounts([]));
    return () => {
      live = false;
    };
  }, [client, open]);
  const accountPhrase = parseAccountCommand(search.query);
  const accountMatches = accountPhrase ? matchAccounts(accounts, accountPhrase) : [];
  const activeWorkspace = workspaces.active?.available ? workspaces.active : null;
  const signInFirst = (account: ProviderAccount) => {
    toast.show({
      tone: "danger",
      title: `Sign in to ${account.displayName} first`,
      description: `${account.displayName} (${accountProviderName(account.providerId)}) isn't signed in. Sign in on the Providers Accounts tab, then try again.`,
    });
    requestProvidersTab("accounts");
    navigate("providers");
  };
  const rebindThread = (account: ProviderAccount, threadId: string) =>
    run(() => {
      if (account.authenticationState === "not_authenticated") return signInFirst(account);
      navigate("threads");
      threadsIntent.request("open", threadId);
      requestRebind(threadId, account.id);
    });
  const setWorkspaceDefault = (account: ProviderAccount, workspace: { id: string; name: string }) =>
    run(async () => {
      if (account.authenticationState === "not_authenticated") return signInFirst(account);
      const provider = accountProviderName(account.providerId);
      try {
        await client.bindProviderAccount(account.providerId, "workspace", workspace.id, account.id);
        toast.show({
          tone: "success",
          title: `New ${provider} threads in ${workspace.name} use ${account.displayName}`,
          description: "Existing threads keep their accounts.",
        });
      } catch (error) {
        toast.show({
          tone: "danger",
          title: "Workspace account wasn't saved",
          description: toKalCodeError(error).message,
        });
      }
    });
  const destinations = [...PRIMARY_ORDER, "settings" as const].filter((id): id is SurfaceId => visible.has(id));
  const views = (["home", "folder"] as const).filter((view) => viewVisible(view, info.flags.features));

  return (
    <Command.Dialog
      ref={commandRoot}
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      overlayClassName={styles.overlay}
      contentClassName={styles.content}
      className={styles.command}
      loop
      value={selected}
      onValueChange={setSelected}
      onPointerMove={(event) => {
        if (event.isTrusted && event.target instanceof Element && event.target.closest("[cmdk-item]"))
          navigatedQuery.current = typed;
      }}
      onKeyDown={(event) => {
        if (
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
          (event.ctrlKey && ["n", "j", "p", "k"].includes(event.key))
        )
          navigatedQuery.current = typed;
        if (event.key !== "Enter" || event.nativeEvent.isComposing || !typed || navigatedQuery.current === typed)
          return;
        const preferred = commandRoot.current ? namedCommand(commandRoot.current, typed) : undefined;
        if (!preferred || preferred.dataset.value === selected) return;
        // A quick Enter can precede the animation-frame selection correction above. Run the
        // explicitly named command now and stop cmdk from dispatching to its weaker fuzzy choice.
        event.preventDefault();
        preferred.click();
      }}
    >
      <Command.Input
        className={styles.input}
        placeholder={locatorVisible ? "Search threads, workspaces and commands" : "Search workspaces and commands"}
        value={search.query}
        onValueChange={search.setQuery}
        maxLength={256}
      />
      {searching ? <LocatorFilterBar state={locator} kinds={search.kinds} onKinds={search.setKinds} /> : null}
      <Command.List className={styles.list}>
        {searching ? (
          <LocatorResultItems
            state={current ? locator : { ...locator, response: null, loading: true }}
            onOpen={(item) => run(() => openLocated(item.kind, item.entityId, "palette"))()}
          />
        ) : null}
        {located > 0 ? null : <Command.Empty className={styles.empty}>No matching commands.</Command.Empty>}

        {visible.has("threads") ? (
          <Command.Group heading="Threads" className={styles.group}>
            <Item
              icon={<MessageSquarePlus />}
              onSelect={run(() => {
                navigate("threads");
                threadsIntent.request("new");
              })}
            >
              New thread
            </Item>
            <Item
              icon={<Search />}
              onSelect={run(() => {
                navigate("threads");
                threadsIntent.request("search");
              })}
            >
              Search threads
            </Item>
          </Command.Group>
        ) : null}

        <Command.Group heading="Go to" className={styles.group}>
          {views.map((id) => {
            const meta = VIEWS[id];
            const Icon = meta.icon;
            return (
              <Item key={id} icon={<Icon />} onSelect={run(() => navigate(id))} keywords={[meta.summary]}>
                {meta.label}
              </Item>
            );
          })}
          {destinations.map((id) => {
            const meta = SURFACES[id];
            const Icon = meta.icon;
            return (
              <Item key={id} icon={<Icon />} onSelect={run(() => navigate(id))} keywords={[meta.summary]}>
                {meta.label}
              </Item>
            );
          })}
        </Command.Group>

        <Command.Group heading="Code" className={styles.group}>
          {workspaces.active?.available ? (
            <Item
              icon={<SquareTerminal />}
              onSelect={run(() => {
                navigate("code");
                return workspaces.createTerminal(null);
              })}
              shortcut={CODE_SHORTCUT_LABELS["new-terminal"]}
              keywords={["shell", "console", "command line", workspaces.active.name]}
            >
              New terminal
            </Item>
          ) : null}
          <Item
            icon={<FolderPlus />}
            onSelect={run(async () => {
              const opened = await workspaces.openFolder();
              if (opened) navigate("code");
            })}
            keywords={["workspace", "project", "folder"]}
          >
            Open folder…
          </Item>
          {workspaces.workspaces
            .filter((w) => w.id !== workspaces.active?.id && w.available)
            .map((workspace) => (
              <Item
                key={workspace.id}
                icon={<ArrowRightLeft />}
                onSelect={run(async () => {
                  if (await workspaces.activate(workspace.id)) navigate("code");
                })}
                keywords={["switch workspace", workspace.displayPath]}
              >
                {`Switch to ${workspace.name}`}
              </Item>
            ))}
        </Command.Group>

        {accountMatches.length > 0 && (selectedThread || activeWorkspace) ? (
          <Command.Group heading="Accounts" className={styles.group}>
            {accountMatches.flatMap((account) => {
              const name = `${account.displayName} (${accountProviderName(account.providerId)})`;
              const keywords = [...accountKeywords(account), search.query.trim()];
              const signedOut = account.authenticationState === "not_authenticated" ? "Signed out" : undefined;
              const items = [];
              if (selectedThread && selectedThread.providerId === account.providerId) {
                const current = selectedThread.providerAccountId === account.id;
                items.push(
                  <Item
                    key={`thread:${account.id}`}
                    icon={<UserRoundCheck />}
                    onSelect={
                      current
                        ? run(() =>
                            toast.show({ tone: "info", title: `This thread already uses ${account.displayName}` }),
                          )
                        : rebindThread(account, selectedThread.threadId)
                    }
                    keywords={keywords}
                    current={current}
                    badge={signedOut}
                  >
                    {`Use ${name} for this thread`}
                  </Item>,
                );
              }
              if (activeWorkspace) {
                items.push(
                  <Item
                    key={`workspace:${account.id}`}
                    icon={<UserRoundCog />}
                    onSelect={setWorkspaceDefault(account, activeWorkspace)}
                    keywords={keywords}
                    badge={signedOut}
                  >
                    {`Use ${name} in this workspace`}
                  </Item>,
                );
              }
              return items;
            })}
          </Command.Group>
        ) : null}

        {visible.has("code") && workspaces.active?.available ? (
          <Command.Group heading="Panes" className={styles.group}>
            <Item
              icon={<Columns2 />}
              onSelect={pane({ kind: "split", axis: "horizontal" })}
              shortcut={PANE_SHORTCUT_LABELS.splitRight}
              keywords={["side by side", "layout"]}
            >
              Split pane right
            </Item>
            <Item
              icon={<Rows2 />}
              onSelect={pane({ kind: "split", axis: "vertical" })}
              shortcut={PANE_SHORTCUT_LABELS.splitDown}
              keywords={["stack", "layout"]}
            >
              Split pane down
            </Item>
            <Item icon={<Maximize2 />} onSelect={pane({ kind: "maximize" })} shortcut={PANE_SHORTCUT_LABELS.maximize}>
              Maximize pane
            </Item>
            <Item icon={<ChevronsDownUp />} onSelect={pane({ kind: "restore" })} keywords={["unmaximize", "layout"]}>
              Restore pane layout
            </Item>
            <Item icon={<Equal />} onSelect={pane({ kind: "even" })} shortcut={PANE_SHORTCUT_LABELS.even}>
              Even out pane sizes
            </Item>
            <Item icon={<Undo2 />} onSelect={pane({ kind: "reopen" })} shortcut={PANE_SHORTCUT_LABELS.reopen}>
              Reopen closed pane
            </Item>
            <Item
              icon={<X />}
              onSelect={pane({ kind: "close" })}
              shortcut={PANE_SHORTCUT_LABELS.close}
              keywords={["keeps running"]}
            >
              Close pane
            </Item>
            {(
              [
                ["two", "Arrange 2 panes"],
                ["three", "Arrange 3 panes"],
                ["four", "Arrange 4 panes (2 × 2)"],
                ["six", "Arrange 6 panes (3 × 2)"],
              ] as const
            ).map(([preset, label]) => (
              <Item
                key={preset}
                icon={<LayoutGrid />}
                onSelect={pane({ kind: "preset", preset })}
                keywords={["layout", "preset", "grid"]}
              >
                {label}
              </Item>
            ))}
          </Command.Group>
        ) : null}

        {/* Z7-W2 surfaces as pane contents (Z7-W1 pane system), beside the focused pane. */}
        {visible.has("code") && workspaces.active?.available ? (
          <Command.Group heading="Show in a pane" className={styles.group}>
            {viewVisible("home", info.flags.features) ? (
              <Item
                icon={<House />}
                onSelect={run(() => openInPane({ kind: "widget", widgetId: HOME_WIDGET }, { placement: "split" }))}
                keywords={["pane", "widget", "today"]}
              >
                Show Home in a pane
              </Item>
            ) : null}
            {viewVisible("folder", info.flags.features) ? (
              <Item
                icon={<FolderGit2 />}
                onSelect={run(() => openInPane({ kind: "widget", widgetId: PROJECT_WIDGET }, { placement: "split" }))}
                keywords={["pane", "widget", "files", workspaces.active.name]}
              >
                Show the project page in a pane
              </Item>
            ) : null}
            {rail?.enabled ? (
              <Item
                icon={<FolderTree />}
                onSelect={run(() =>
                  openInPane({ kind: "widget", widgetId: WORKSPACES_WIDGET }, { placement: "split" }),
                )}
                keywords={["pane", "widget", "rail"]}
              >
                Show workspaces in a pane
              </Item>
            ) : null}
            {featureVisible("git_core") ? (
              <Item
                icon={<GitCommitHorizontal />}
                onSelect={run(() => {
                  const workspaceId = workspaces.active?.id;
                  return workspaceId
                    ? openInPane({ kind: "git", workspaceId }, { workspaceId, placement: "split" })
                    : null;
                })}
                keywords={["pane", "changes", "status", workspaces.active.name]}
              >
                Show Git status in a pane
              </Item>
            ) : null}
          </Command.Group>
        ) : null}

        <Command.Group heading="Appearance" className={styles.group}>
          <Item icon={<Monitor />} onSelect={set({ theme: "system" })} current={settings.theme === "system"}>
            Use system theme
          </Item>
          <Item icon={<Sun />} onSelect={set({ theme: "light" })} current={settings.theme === "light"}>
            Use light theme
          </Item>
          <Item icon={<Moon />} onSelect={set({ theme: "dark" })} current={settings.theme === "dark"}>
            Use dark theme
          </Item>
          <Item
            icon={<Rows3 />}
            onSelect={set({ density: settings.density === "compact" ? "comfortable" : "compact" })}
          >
            {settings.density === "compact" ? "Use comfortable density" : "Use compact density"}
          </Item>
          <Item
            icon={<PanelLeft />}
            onSelect={set({ sidebarCollapsed: !settings.sidebarCollapsed })}
            shortcut={`${MOD_LABEL} B`}
          >
            {settings.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          </Item>
          {rail?.enabled ? (
            <Item
              icon={<PanelsLeftBottom />}
              onSelect={run(rail.toggleHidden)}
              shortcut={RAIL_SHORTCUT}
              keywords={["workspaces", "rail", "projects"]}
            >
              {rail.hidden ? "Show the workspace rail" : "Hide the workspace rail"}
            </Item>
          ) : null}
        </Command.Group>

        {kalvoice?.status ? (
          <Command.Group heading="KalVoice" className={styles.group}>
            <Item
              icon={<AudioLines />}
              onSelect={run(() => kalvoice.setPanelVisible(!kalvoice.panel.visible))}
              keywords={["voice", "push to talk", "orb"]}
            >
              {kalvoice.panel.visible ? "Hide the KalVoice widget" : "Show the KalVoice widget"}
            </Item>
          </Command.Group>
        ) : null}

        <Command.Group heading="Diagnostics" className={styles.group}>
          <Item icon={<ClipboardCopy />} onSelect={run(diagnostics.copyReport)}>
            Copy diagnostic report
          </Item>
          <Item icon={<FolderOpen />} onSelect={run(diagnostics.openLogs)}>
            Open logs folder
          </Item>
          <Item icon={<KeyRound />} onSelect={run(diagnostics.checkSecureStore)}>
            Check credential store
          </Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}

interface ItemProps {
  icon: ReactNode;
  children: string;
  onSelect: () => void;
  keywords?: string[];
  shortcut?: string;
  current?: boolean;
  /** A short state shown after the label ("Signed out"). */
  badge?: string | undefined;
}

function Item({ icon, children, onSelect, keywords, shortcut, current, badge }: ItemProps) {
  return (
    <Command.Item className={styles.item} onSelect={onSelect} value={children} {...(keywords ? { keywords } : {})}>
      <span className={styles.itemIcon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.itemLabel}>{children}</span>
      {current ? <span className={styles.current}>Current</span> : null}
      {badge ? <span className={styles.current}>{badge}</span> : null}
      {shortcut ? <kbd>{shortcut}</kbd> : null}
    </Command.Item>
  );
}
