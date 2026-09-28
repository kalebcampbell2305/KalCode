import { type CSSProperties, useCallback, useLayoutEffect, useRef } from "react";
import { FloatingAssistant } from "../kalvoice/FloatingAssistant.tsx";
import { KalVoicePage } from "../kalvoice/KalVoicePage.tsx";
import { KalVoiceProvider } from "../kalvoice/KalVoiceProvider.tsx";
import { PushToTalkActivity } from "../kalvoice/PushToTalkActivity.tsx";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { UiIntentsProvider } from "../runtime/uiIntents.tsx";
import { WorkspaceProvider } from "../runtime/WorkspaceProvider.tsx";
import { CodePage } from "../surfaces/code/CodePage.tsx";
import { useNewTerminalShortcut } from "../surfaces/code/useNewTerminalShortcut.ts";
import { Dashboard } from "../surfaces/dashboard/Dashboard.tsx";
import { focusSection } from "../surfaces/dashboard/useNow.ts";
import { FolderSurface } from "../surfaces/folder/FolderSurface.tsx";
import { GatedSurface } from "../surfaces/gated/GatedSurface.tsx";
import { HomeSurface } from "../surfaces/home/HomeSurface.tsx";
import { ApprovalAnnouncer, ApprovalsPanel, PermissionsProvider } from "../surfaces/permissions/index.ts";
import { ProvidersPage } from "../surfaces/providers/ProvidersPage.tsx";
import { SettingsPage } from "../surfaces/settings/SettingsPage.tsx";
import { ThreadsIntentProvider } from "../surfaces/threads/intent.tsx";
import { ThreadsSurface } from "../surfaces/threads/ThreadsSurface.tsx";
import { useAppearance } from "./appearance.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { destinationMeta, NavigationProvider, useNavigation } from "./navigation.tsx";
import { NotificationCenter } from "./notifications/NotificationCenter.tsx";
import { NotificationsProvider } from "./notifications/NotificationsProvider.tsx";
// Z7-W2: Home, the project page, the workspace list and Git status as pane contents.
import "./rail/paneContents.tsx";
import { RailProvider, useRail } from "./rail/RailProvider.tsx";
import { SearchProvider, useSearch } from "./rail/search/SearchProvider.tsx";
import { useRailShortcut } from "./rail/useRailShortcut.ts";
import { WorkspaceRail } from "./rail/WorkspaceRail.tsx";
import styles from "./Shell.module.css";
import { ShellSlotsProvider, useShellSlots } from "./ShellSlots.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { useShortcuts } from "./shortcuts.ts";
import { UpdateReadyNotice } from "./UpdateReadyNotice.tsx";

export function Shell() {
  const { info, settings, client } = useRuntime();
  useAppearance(settings, client);
  // KalVoice (Z12) runs when its surface is enabled for this build channel.
  const kalvoiceFlag = info.flags.surfaces.find((s) => s.id === "kalvoice");
  const kalvoiceEnabled = Boolean(kalvoiceFlag?.visible && kalvoiceFlag.state !== "gated");
  return (
    <NavigationProvider flags={info.flags.surfaces} features={info.flags.features}>
      <WorkspaceProvider>
        <PermissionsProvider>
          <ThreadsIntentProvider>
            {/* Z7-W3: cross-surface focus/filter intents and the notification center. */}
            <UiIntentsProvider>
              <NotificationsProvider>
                <ShellSlotsProvider>
                  {/* Z7-W2: shared search (palette + locator) and the workspace rail. */}
                  <SearchProvider>
                    <RailProvider>
                      {kalvoiceEnabled ? (
                        <KalVoiceProvider>
                          <ShellLayout kalvoice />
                        </KalVoiceProvider>
                      ) : (
                        <ShellLayout kalvoice={false} />
                      )}
                    </RailProvider>
                  </SearchProvider>
                </ShellSlotsProvider>
              </NotificationsProvider>
            </UiIntentsProvider>
          </ThreadsIntentProvider>
        </PermissionsProvider>
      </WorkspaceProvider>
    </NavigationProvider>
  );
}

function ShellLayout({ kalvoice }: { kalvoice: boolean }) {
  const { settings, updateSettings, client } = useRuntime();
  const { current, navigate } = useNavigation();
  // Z7-W2: the palette's open state and query are shared (search can open with a query).
  const { open: paletteOpen, setOpen: setPaletteOpen } = useSearch();
  const rail = useRail();
  const slots = useShellSlots();
  const voice = slots?.voice ?? null;
  const setMainLeft = slots?.setMainLeft;
  const mainRef = useRef<HTMLElement>(null);
  // The KalVoice widget stays right of the sidebar (Z7-W1 shell slot).
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main || !setMainLeft) return;
    const measure = () => setMainLeft(main.getBoundingClientRect().left);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    return () => observer.disconnect();
  }, [setMainLeft]);

  useShortcuts({
    openPalette: () => setPaletteOpen(true),
    toggleSidebar: () => void updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed }),
  });
  useNewTerminalShortcut();
  useRailShortcut();

  // The update-ready notice's "Details" opens Settings → Updates once the page has rendered.
  const openUpdateDetails = useCallback(() => {
    navigate("settings");
    requestAnimationFrame(() => requestAnimationFrame(() => focusSection("updates")));
  }, [navigate]);

  return (
    <div
      className={styles.shell}
      data-sidebar={settings.sidebarCollapsed ? "collapsed" : "expanded"}
      data-rail={rail.enabled ? (rail.hidden ? "strip" : "shown") : "none"}
      data-voice-slot={voice?.edge}
      style={voice ? ({ "--voice-slot-h": `${voice.height}px` } as CSSProperties) : undefined}
    >
      <a className={styles.skipLink} href="#main">
        Skip to content
      </a>
      <Sidebar collapsed={settings.sidebarCollapsed} onOpenPalette={() => setPaletteOpen(true)} />
      {voice ? <div className={styles.voiceSlot} data-edge={voice.edge} aria-hidden="true" /> : null}
      <WorkspaceRail />
      <main
        ref={mainRef}
        id="main"
        className={styles.main}
        tabIndex={-1}
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
        ) : current === "code" ? (
          <CodePage />
        ) : current === "settings" ? (
          <SettingsPage />
        ) : current === "providers" ? (
          <ProvidersPage />
        ) : current === "threads" ? (
          <ThreadsSurface />
        ) : (
          <GatedSurface id={current} />
        )}
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      {kalvoice ? <FloatingAssistant /> : null}
      {kalvoice ? <PushToTalkActivity /> : null}
      <ApprovalsPanel />
      <ApprovalAnnouncer />
      <NotificationCenter />
      <UpdateReadyNotice client={client} onOpenDetails={openUpdateDetails} />
    </div>
  );
}
