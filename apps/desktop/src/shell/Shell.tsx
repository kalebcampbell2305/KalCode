import { useState } from "react";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { WorkspaceProvider } from "../runtime/WorkspaceProvider.tsx";
import { CodePage } from "../surfaces/code/CodePage.tsx";
import { useNewTerminalShortcut } from "../surfaces/code/useNewTerminalShortcut.ts";
import { Dashboard } from "../surfaces/dashboard/Dashboard.tsx";
import { GatedSurface } from "../surfaces/gated/GatedSurface.tsx";
import { ProvidersPage } from "../surfaces/providers/ProvidersPage.tsx";
import { ApprovalAnnouncer, ApprovalsPanel, PermissionsProvider } from "../surfaces/permissions/index.ts";
import { SettingsPage } from "../surfaces/settings/SettingsPage.tsx";
import { ThreadsIntentProvider } from "../surfaces/threads/intent.tsx";
import { ThreadsSurface } from "../surfaces/threads/ThreadsSurface.tsx";
import { useAppearance } from "./appearance.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { NavigationProvider, SURFACES, useNavigation } from "./navigation.tsx";
import styles from "./Shell.module.css";
import { Sidebar } from "./Sidebar.tsx";
import { useShortcuts } from "./shortcuts.ts";

export function Shell() {
  const { info, settings, client } = useRuntime();
  useAppearance(settings, client);
  return (
    <NavigationProvider flags={info.flags.surfaces}>
      <WorkspaceProvider>
        <PermissionsProvider>
          <ThreadsIntentProvider>
            <ShellLayout />
          </ThreadsIntentProvider>
        </PermissionsProvider>
      </WorkspaceProvider>
    </NavigationProvider>
  );
}

function ShellLayout() {
  const { settings, updateSettings } = useRuntime();
  const { current } = useNavigation();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useShortcuts({
    openPalette: () => setPaletteOpen(true),
    toggleSidebar: () => void updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed }),
  });
  useNewTerminalShortcut();

  return (
    <div className={styles.shell} data-sidebar={settings.sidebarCollapsed ? "collapsed" : "expanded"}>
      <a className={styles.skipLink} href="#main">
        Skip to content
      </a>
      <Sidebar collapsed={settings.sidebarCollapsed} onOpenPalette={() => setPaletteOpen(true)} />
      <main id="main" className={styles.main} tabIndex={-1} aria-label={SURFACES[current].label} data-surface={current}>
        {current === "dashboard" ? (
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
      <ApprovalsPanel />
      <ApprovalAnnouncer />
    </div>
  );
}
