import { type CSSProperties, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { OperationsClient } from "../ipc/operations.ts";
import { FloatingAssistant } from "../kalvoice/FloatingAssistant.tsx";
import { KalVoicePage } from "../kalvoice/KalVoicePage.tsx";
import { KalVoiceProvider } from "../kalvoice/KalVoiceProvider.tsx";
import { PushToTalkActivity } from "../kalvoice/PushToTalkActivity.tsx";
import { SessionChoicePanel } from "../kalvoice/SessionChoicePanel.tsx";
import { NavigationBridge } from "../runtime/NavigationBridge.tsx";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { UiIntentsProvider } from "../runtime/uiIntents.tsx";
import { WorkspaceProvider } from "../runtime/WorkspaceProvider.tsx";
import { CodePage } from "../surfaces/code/CodePage.tsx";
import { KalTidyProvider } from "../surfaces/code/kaltidy/KalTidyProvider.tsx";
import { useNewTerminalShortcut } from "../surfaces/code/useNewTerminalShortcut.ts";
import { Dashboard } from "../surfaces/dashboard/Dashboard.tsx";
import { DashboardDataBoundary } from "../surfaces/dashboard/data/DashboardData.tsx";
import { focusSection } from "../surfaces/dashboard/useNow.ts";
import { FolderSurface } from "../surfaces/folder/FolderSurface.tsx";
import { GatedSurface } from "../surfaces/gated/GatedSurface.tsx";
import { HomeSurface } from "../surfaces/home/HomeSurface.tsx";
import { UnifiedMemory } from "../surfaces/memory/UnifiedMemory.tsx";
import { OperationsPage } from "../surfaces/operations/OperationsPage.tsx";
import { ApprovalAnnouncer, ApprovalsPanel, PermissionsProvider } from "../surfaces/permissions/index.ts";
import { ProviderAccountSessionsProvider } from "../surfaces/providers/ProviderAccountSessions.tsx";
import { ProvidersPage } from "../surfaces/providers/ProvidersPage.tsx";
import { SettingsPage } from "../surfaces/settings/SettingsPage.tsx";
import { ThreadsIntentProvider } from "../surfaces/threads/intent.tsx";
import { ThreadsSurface } from "../surfaces/threads/ThreadsSurface.tsx";
import { useAppearance } from "./appearance.ts";
import { CodeStartup } from "./CodeStartup.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { AgentRail } from "./deck/AgentRail.tsx";
import { CommandBar } from "./deck/CommandBar.tsx";
import { DeckDataProvider } from "./deck/DeckData.tsx";
import { DeckUiProvider } from "./deck/DeckUi.tsx";
import { NavigationBar } from "./NavigationBar.tsx";
import { destinationMeta, NavigationProvider, useNavigation } from "./navigation.tsx";
import { NotificationCenter } from "./notifications/NotificationCenter.tsx";
import { NotificationsProvider } from "./notifications/NotificationsProvider.tsx";
// Z7-W2: Home, the project page, the workspace list and Git status as pane contents.
import "./rail/paneContents.tsx";
import { FavoritesBar } from "./favorites/FavoritesBar.tsx";
import { RailProvider, useRail } from "./rail/RailProvider.tsx";
import { SearchProvider, useSearchOpen } from "./rail/search/SearchProvider.tsx";
import { useRailShortcut } from "./rail/useRailShortcut.ts";
import { WorkspaceRail } from "./rail/WorkspaceRail.tsx";
import styles from "./Shell.module.css";
import { ShellSlotsProvider, useShellSlots } from "./ShellSlots.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { useShortcuts } from "./shortcuts.ts";
import { spaceLevelOf } from "./spaceLevel.ts";
import { UpdateReadyNotice } from "./UpdateReadyNotice.tsx";

export function Shell() {
  const { info, settings, client } = useRuntime();
  useAppearance(settings, client);
  // KalVoice (Z12) runs when its surface is enabled for this build channel.
  const kalvoiceFlag = info.flags.surfaces.find((s) => s.id === "kalvoice");
  const kalvoiceEnabled = Boolean(kalvoiceFlag?.visible && kalvoiceFlag.state !== "gated");
  return (
    <ProviderAccountSessionsProvider>
      <NavigationProvider flags={info.flags.surfaces} features={info.flags.features}>
        <WorkspaceProvider>
          <CodeStartup />
          <PermissionsProvider>
            <ThreadsIntentProvider>
              {/* Z7-W3: cross-surface focus/filter intents and the notification center. */}
              <UiIntentsProvider>
                <NotificationsProvider>
                  <ShellSlotsProvider>
                    {/* Z7-W2: shared search (palette + locator) and the workspace rail. */}
                    <SearchProvider>
                      <RailProvider>
                        {/* KalTidy wraps KalVoice, which stops idle terminals through it. */}
                        <KalTidyProvider>
                          {kalvoiceEnabled ? (
                            <KalVoiceProvider>
                              <ShellLayout kalvoice />
                            </KalVoiceProvider>
                          ) : (
                            <ShellLayout kalvoice={false} />
                          )}
                        </KalTidyProvider>
                      </RailProvider>
                    </SearchProvider>
                  </ShellSlotsProvider>
                </NotificationsProvider>
              </UiIntentsProvider>
            </ThreadsIntentProvider>
          </PermissionsProvider>
        </WorkspaceProvider>
      </NavigationProvider>
    </ProviderAccountSessionsProvider>
  );
}

function ShellLayout({ kalvoice }: { kalvoice: boolean }) {
  const { settings, updateSettings, client } = useRuntime();
  const { current, navigate, back, forward } = useNavigation();
  const operationsClient = useMemo(
    () => new OperationsClient((command, args) => client.transport.invoke(command, args)),
    [client],
  );
  const threadOptions = useCallback(() => client.threadOptions(), [client]);
  const providerAccounts = useCallback(() => client.listProviderAccounts(), [client]);
  // Z7-W2: the palette's open state and query are shared (search can open with a query).
  const { open: paletteOpen, setOpen: setPaletteOpen } = useSearchOpen();
  const rail = useRail();
  const slots = useShellSlots();
  const voice = slots?.voice ?? null;
  const setMainLeft = slots?.setMainLeft;
  const setInsets = slots?.setInsets;
  const mainRef = useRef<HTMLElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  // Set on the first visit to Code and never cleared (see the Code wrapper in <main>).
  const codeOpened = useRef(false);
  if (current === "code") codeOpened.current = true;
  // One element for the life of the shell, so shell re-renders (the palette opening, the rail
  // refreshing) skip the kept-mounted Code subtree; it still updates from its own state.
  const codePage = useMemo(() => <CodePage />, []);
  // The KalVoice widget stays right of the sidebar (Z7-W1 shell slot), and inside the Command
  // Deck's chrome: below the top bar and left of the agents rail.
  useLayoutEffect(() => {
    const main = mainRef.current;
    const deck = deckRef.current;
    if (!main || !deck || !setMainLeft) return;
    const measure = () => {
      const page = main.getBoundingClientRect();
      const body = deck.getBoundingClientRect();
      setMainLeft(page.left);
      setInsets?.({
        top: body.top,
        right: Math.max(0, window.innerWidth - page.right),
        bottom: Math.max(0, window.innerHeight - body.bottom),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    observer.observe(deck);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [setMainLeft, setInsets]);

  useShortcuts({
    openPalette: () => setPaletteOpen(true),
    toggleSidebar: () => void updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed }),
    back: () => void back(),
    forward: () => void forward(),
    openSettings: () => navigate("settings"),
  });
  useNewTerminalShortcut();
  useRailShortcut();

  // The update-ready notice's "Details" opens Settings → Updates once the page has rendered.
  const openUpdateDetails = useCallback(() => {
    navigate("settings");
    requestAnimationFrame(() => requestAnimationFrame(() => focusSection("updates")));
  }, [navigate]);

  return (
    <DashboardDataBoundary>
      <DeckUiProvider>
        <DeckDataProvider>
          <div className={styles.space} data-space={spaceLevelOf(current)}>
            {/* The deep-space atmosphere: real, inert layers behind the frame, never pseudo-elements
                on it (axe's contrast check gives up on text under a large pseudo-element). */}
            <div className={styles.atmosphere} aria-hidden="true">
              <div className={styles.stars} />
              <div className={styles.nebula} />
            </div>
            <div className={styles.frame} data-app-shell="">
              <NavigationBridge />
              <a className={styles.skipLink} href="#main">
                Skip to content
              </a>
              {/* Command Deck: top bar · (projects · page · agents). */}
              <CommandBar onOpenPalette={() => setPaletteOpen(true)} sidebarCollapsed={settings.sidebarCollapsed} />
              <div>
                <NavigationBar />
                <FavoritesBar />
              </div>
              <div
                ref={deckRef}
                className={styles.shell}
                data-sidebar={settings.sidebarCollapsed ? "collapsed" : "expanded"}
                data-rail={rail.enabled ? (rail.hidden ? "strip" : "shown") : "none"}
                data-voice-slot={voice?.edge}
                style={voice ? ({ "--voice-slot-h": `${voice.height}px` } as CSSProperties) : undefined}
              >
                <Sidebar collapsed={settings.sidebarCollapsed} onOpenPalette={() => setPaletteOpen(true)} />
                {voice ? <div className={styles.voiceSlot} data-edge={voice.edge} aria-hidden="true" /> : null}
                <WorkspaceRail />
                <main
                  ref={mainRef}
                  id="main"
                  className={styles.main}
                  // A scrolling page is a keyboard stop, so text-only pages (and any page at a large
                  // Text size) can be scrolled without a mouse. Code scrolls inside its terminals.
                  tabIndex={current === "code" ? -1 : 0}
                  aria-label={destinationMeta(current).label}
                  data-surface={current}
                >
                  {current === "home" ? (
                    <HomeSurface />
                  ) : current === "folder" ? (
                    <FolderSurface />
                  ) : current === "kalvoice" && kalvoice ? (
                    <KalVoicePage />
                  ) : current === "dashboard" ? (
                    <Dashboard />
                  ) : current === "operations" ? (
                    <OperationsPage
                      client={operationsClient}
                      threadOptions={threadOptions}
                      providerAccounts={providerAccounts}
                    />
                  ) : current === "code" ? null : current === "settings" ? (
                    <SettingsPage />
                  ) : current === "providers" ? (
                    <ProvidersPage />
                  ) : current === "threads" ? (
                    <ThreadsSurface />
                  ) : current === "memory" ? (
                    <UnifiedMemory />
                  ) : (
                    <GatedSurface id={current} />
                  )}
                  {/* Code stays mounted once opened, hidden while another page is shown: its
                    terminals, attachments and layout survive navigation instead of rebuilding. */}
                  {codeOpened.current ? (
                    <div className={styles.codeSurface} hidden={current !== "code"}>
                      {codePage}
                    </div>
                  ) : null}
                </main>
                <AgentRail />
              </div>
              <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
              {kalvoice ? <FloatingAssistant /> : null}
              {kalvoice ? <PushToTalkActivity /> : null}
              {kalvoice ? <SessionChoicePanel /> : null}
              <ApprovalsPanel />
              <ApprovalAnnouncer />
              <NotificationCenter />
              <UpdateReadyNotice client={client} onOpenDetails={openUpdateDetails} />
            </div>
          </div>
        </DeckDataProvider>
      </DeckUiProvider>
    </DashboardDataBoundary>
  );
}
