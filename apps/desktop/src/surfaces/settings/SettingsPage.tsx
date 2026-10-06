import type { ContrastPreference, Density, MotionPreference, TextSize, ThemePreference } from "@kalcode/protocol";
import { Button, ErrorState, KeyValueList, Panel, SegmentedControl, Skeleton, useToast } from "@kalcode/ui/components";
import { Activity, ClipboardCopy, FolderOpen, Info, KeyRound, Monitor, Moon, Palette, Sun } from "lucide-react";
import type { ReactNode } from "react";
import kalcodeMascot362 from "../../assets/brand/kalcode-mascot-362.webp";
import kalcodeMascot724 from "../../assets/brand/kalcode-mascot-724.webp";
import { KalVoiceSettings } from "../../kalvoice/KalVoiceSettings.tsx";
import { formatVersion } from "../../platform/version.ts";
import { formatAbsolute } from "../../runtime/describeEvent.ts";
import { useDeskRestore } from "../../runtime/deskRestore.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useDiagnostics } from "../../runtime/useDiagnostics.ts";
import { KalCodeTagline, Wordmark } from "../../shell/Brand.tsx";
import { viewVisible } from "../../shell/navigation.tsx";
import { Page } from "../../shell/Page.tsx";
import { DoctorSettings } from "../doctor/DoctorSettings.tsx";
import { IntegrationSettings } from "../integrations/IntegrationSettings.tsx";
import { PermissionsSettings } from "../permissions/index.ts";
import { ResourceGovernorSettingsGate } from "../resources/ResourceGovernorSettingsGate.tsx";
import { ProfileSettings } from "./ProfileSettings.tsx";
import { SettingsAccount } from "./SettingsAccount.tsx";
import styles from "./SettingsPage.module.css";
import { useSettingsNavigation } from "./settingsIntent.ts";
import { UpdaterSettings } from "./UpdaterSettings.tsx";
import { useDiagnosticsActions } from "./useDiagnosticsActions.ts";

const OS_NAMES: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

function formatOs(family: string): string {
  return OS_NAMES[family] ?? family;
}

export function SettingsPage() {
  const { info } = useRuntime();
  const recordFocus = useSettingsNavigation();
  // The display name only appears on Home; without Home (Stable) the setting would do nothing.
  const homeVisible = viewVisible("home", info.flags.features);
  return (
    <div onFocusCapture={(event) => recordFocus(event.target)}>
      <Page title="Settings" description="Changes apply immediately and are saved on this device.">
        <div id="integrations" data-settings-section>
          <IntegrationSettings />
        </div>
        {/* One column up to wide windows; then permissions get a column of their own. */}
        <div className={styles.layout}>
          <div className={styles.column}>
            {homeVisible ? <ProfileSettings /> : null}
            <SettingsAccount />
            <Appearance />
            <DeskRestoreSettings />
            <KalVoiceSettings />
            <div id="resources" data-settings-section>
              <ResourceGovernorSettingsGate />
            </div>
            <div id="doctor" data-settings-section>
              <DoctorSettings />
            </div>
            <UpdaterSettings />
            <DiagnosticsSection />
            <About />
          </div>
          <div className={styles.column}>
            <PermissionsSettings />
          </div>
        </div>
      </Page>
    </div>
  );
}

function SettingRow({ id, label, help, control }: { id: string; label: string; help: string; control: ReactNode }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <p id={`${id}-label`} className={styles.rowLabel}>
          {label}
        </p>
        <p id={`${id}-help`} className={styles.rowHelp}>
          {help}
        </p>
      </div>
      <div className={styles.rowControl}>{control}</div>
    </div>
  );
}

function Appearance() {
  const { settings, updateSettings } = useRuntime();
  return (
    <Panel id="appearance" title="Appearance" icon={<Palette />} padding="none">
      <div className={styles.rows}>
        <SettingRow
          id="theme"
          label="Theme"
          help="System follows your operating system's light or dark setting."
          control={
            <SegmentedControl<ThemePreference>
              aria-labelledby="theme-label"
              value={settings.theme}
              onValueChange={(theme) => void updateSettings({ theme })}
              options={[
                { value: "system", label: "System", icon: <Monitor /> },
                { value: "light", label: "Light", icon: <Sun /> },
                { value: "dark", label: "Dark", icon: <Moon /> },
              ]}
            />
          }
        />
        <SettingRow
          id="motion"
          label="Motion"
          help="Reduced turns off animations. System follows your operating system's preference."
          control={
            <SegmentedControl<MotionPreference>
              aria-labelledby="motion-label"
              value={settings.motion}
              onValueChange={(motion) => void updateSettings({ motion })}
              options={[
                { value: "system", label: "System" },
                { value: "reduced", label: "Reduced" },
                { value: "full", label: "Full" },
              ]}
            />
          }
        />
        <SettingRow
          id="density"
          label="Density"
          help="Compact fits more rows on screen."
          control={
            <SegmentedControl<Density>
              aria-labelledby="density-label"
              value={settings.density}
              onValueChange={(density) => void updateSettings({ density })}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
            />
          }
        />
        <SettingRow
          id="contrast"
          label="Contrast"
          help="High raises text, border and focus contrast and removes background effects. System follows your operating system."
          control={
            <SegmentedControl<ContrastPreference>
              aria-labelledby="contrast-label"
              value={settings.contrast ?? "system"}
              onValueChange={(contrast) => void updateSettings({ contrast })}
              options={[
                { value: "system", label: "System" },
                { value: "standard", label: "Standard" },
                { value: "more", label: "High" },
              ]}
            />
          }
        />
        <SettingRow
          id="text-size"
          label="Text size"
          help="Scales text and controls across KalCode, terminals included."
          control={
            <SegmentedControl<TextSize>
              aria-labelledby="text-size-label"
              value={settings.textSize ?? "default"}
              onValueChange={(textSize) => void updateSettings({ textSize })}
              options={[
                { value: "default", label: "Default" },
                { value: "large", label: "Large" },
                { value: "larger", label: "Larger" },
              ]}
            />
          }
        />
      </div>
    </Panel>
  );
}

function DeskRestoreSettings() {
  const { automatic, setAutomatic } = useDeskRestore();
  const toast = useToast();
  return (
    <Panel id="continuity" title="Continue where I left off" icon={<Monitor />} padding="none">
      <div className={styles.rows}>
        <SettingRow
          id="desk-restore"
          label="Restore my desk on startup"
          help="Reopen your saved layout and resume eligible coding agents in the background. Finished commands and intentionally closed agents stay ended."
          control={
            <SegmentedControl
              aria-labelledby="desk-restore-label"
              value={automatic ? "automatic" : "manual"}
              onValueChange={(value) => {
                if (!setAutomatic(value === "automatic"))
                  toast.show({
                    tone: "danger",
                    title: "Startup preference couldn't be saved",
                    description: "Device storage is unavailable. Try again.",
                  });
              }}
              options={[
                { value: "automatic", label: "Automatically" },
                { value: "manual", label: "When I choose" },
              ]}
            />
          }
        />
      </div>
    </Panel>
  );
}

function DiagnosticsSection() {
  const { data, error, refresh } = useDiagnostics();
  const { copyReport, openLogs, checkSecureStore, checking } = useDiagnosticsActions();

  return (
    <Panel
      id="diagnostics"
      title="Diagnostics"
      icon={<Activity />}
      description="Health information for support. Reports never include project files, prompts or credentials."
      padding="none"
      bodyClassName={styles.panelBody}
      footer={
        <div className={styles.actions}>
          <Button icon={<ClipboardCopy />} onClick={() => void copyReport()}>
            Copy diagnostic report
          </Button>
          <Button icon={<FolderOpen />} onClick={() => void openLogs()}>
            Open logs folder
          </Button>
          <Button icon={<KeyRound />} onClick={() => void checkSecureStore()} busy={checking}>
            Check credential store
          </Button>
        </div>
      }
    >
      {error && !data ? (
        <ErrorState title="Diagnostics unavailable" actions={<Button onClick={refresh}>Try again</Button>}>
          <p>{error.message}</p>
        </ErrorState>
      ) : !data ? (
        <div role="status" aria-busy="true" className={styles.loading}>
          <span className="visually-hidden">Loading diagnostics</span>
          <Skeleton width="60%" />
          <Skeleton width="45%" />
          <Skeleton width="70%" />
        </div>
      ) : (
        <KeyValueList
          className={styles.kv}
          items={[
            { key: "version", label: "Version", value: `${formatVersion(data.app.version)} (${data.app.channel})` },
            {
              key: "os",
              label: "Operating system",
              value: `${formatOs(data.os.family)} ${data.os.version}, ${data.os.arch}`,
            },
            {
              key: "schema",
              label: "Database schema",
              value: `Version ${data.database.schemaVersion} of ${data.database.latestSchemaVersion}, ${data.database.journalMode.toUpperCase()} journal`,
            },
            { key: "events", label: "Recorded events", value: data.database.eventCount.toLocaleString() },
            {
              key: "keychain",
              label: "Credential store",
              value:
                data.secureStore.lastCheckedAt === null
                  ? "Not checked yet"
                  : `${data.secureStore.lastCheckOk ? "Verified" : "Failed"} ${formatAbsolute(data.secureStore.lastCheckedAt)}${
                      data.secureStore.backend ? `, ${data.secureStore.backend}` : ""
                    }`,
            },
            { key: "data", label: "Data folder", value: <code data-selectable>{data.paths.dataDir}</code> },
            { key: "logs", label: "Logs folder", value: <code data-selectable>{data.paths.logDir}</code> },
          ]}
        />
      )}
    </Panel>
  );
}

function About() {
  const { info } = useRuntime();
  return (
    <Panel id="about" title="About KalCode" icon={<Info />} padding="none">
      <figure className={styles.about}>
        <img
          src={kalcodeMascot362}
          srcSet={`${kalcodeMascot362} 362w, ${kalcodeMascot724} 724w`}
          sizes="10rem"
          width={362}
          height={362}
          alt="The KalCode mascot, a pixel character holding a laptop marked K"
          className={styles.aboutMascot}
        />
        <figcaption className={styles.aboutText}>
          <span className={styles.aboutLockup}>
            <Wordmark className={styles.aboutWordmark} />
            <KalCodeTagline className={styles.aboutTagline} />
          </span>
          <p className={styles.aboutMeta}>
            {info.channel === "stable"
              ? `Version ${formatVersion(info.version)}`
              : `Version ${formatVersion(info.version)}, ${info.channel} build`}
          </p>
        </figcaption>
      </figure>
    </Panel>
  );
}
