import { useState } from "react";
import { FloatingAssistant } from "../kalvoice/FloatingAssistant.tsx";
import { KalVoicePage } from "../kalvoice/KalVoicePage.tsx";
import { KalVoiceProvider } from "../kalvoice/KalVoiceProvider.tsx";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { Dashboard } from "../surfaces/dashboard/Dashboard.tsx";
import { GatedSurface } from "../surfaces/gated/GatedSurface.tsx";
import { ProvidersPage } from "../surfaces/providers/ProvidersPage.tsx";
import { SettingsPage } from "../surfaces/settings/SettingsPage.tsx";
import { useAppearance } from "./appearance.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { NavigationProvider, SURFACES, useNavigation } from "./navigation.tsx";
import styles from "./Shell.module.css";
import { Sidebar } from "./Sidebar.tsx";
import { useShortcuts } from "./shortcuts.ts";

export function Shell() {
  const { info, settings, client } = useRuntime();
  useAppearance(settings, client);
  // KalVoice (Z12) runs when its surface is enabled for this build channel.
  const kalvoiceFlag = info.flags.surfaces.find((s) => s.id === "kalvoice");
  const kalvoiceEnabled = Boolean(kalvoiceFlag?.visible && kalvoiceFlag.state !== "gated");
  return (
    <NavigationProvider flags={info.flags.surfaces}>
      {kalvoiceEnabled ? (
        <KalVoiceProvider>
          <ShellLayout kalvoice />
        </KalVoiceProvider>
      ) : (
        <ShellLayout kalvoice={false} />
      )}
    </NavigationProvider>
  );
}

function ShellLayout({ kalvoice }: { kalvoice: boolean }) {
  const { settings, updateSettings } = useRuntime();
  const { current } = useNavigation();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useShortcuts({
    openPalette: () => setPaletteOpen(true),
    toggleSidebar: () => void updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed }),
  });

  return (
    <div className={styles.shell} data-sidebar={settings.sidebarCollapsed ? "collapsed" : "expanded"}>
      <a className={styles.skipLink} href="#main">
        Skip to content
      </a>
      <Sidebar collapsed={settings.sidebarCollapsed} onOpenPalette={() => setPaletteOpen(true)} />
      <main id="main" className={styles.main} tabIndex={-1} aria-label={SURFACES[current].label}>
        {current === "kalvoice" && kalvoice ? (
          <KalVoicePage />
        ) : current === "dashboard" ? (
          <Dashboard />
        ) : current === "settings" ? (
          <SettingsPage />
        ) : current === "providers" ? (
          <ProvidersPage />
        ) : (
          <GatedSurface id={current} />
        )}
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      {kalvoice ? <FloatingAssistant /> : null}
    </div>
  );
}
