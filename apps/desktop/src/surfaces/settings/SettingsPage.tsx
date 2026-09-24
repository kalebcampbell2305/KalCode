import type { Density, MotionPreference, ThemePreference } from "@kalcode/protocol";
import { Button, ErrorState, KeyValueList, Section, SegmentedControl, Skeleton } from "@kalcode/ui/components";
import { ClipboardCopy, FolderOpen, KeyRound, Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import kalcodeGlobe362 from "../../assets/brand/kalcode-globe-362.webp";
import kalcodeGlobe724 from "../../assets/brand/kalcode-globe-724.webp";
import { formatAbsolute } from "../../runtime/describeEvent.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useDiagnostics } from "../../runtime/useDiagnostics.ts";
import { KalCodeTagline, Wordmark } from "../../shell/Brand.tsx";
import { Page } from "../../shell/Page.tsx";
import styles from "./SettingsPage.module.css";
import { useDiagnosticsActions } from "./useDiagnosticsActions.ts";

const OS_NAMES: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

function formatOs(family: string): string {
  return OS_NAMES[family] ?? family;
}

export function SettingsPage() {
  return (
    <Page title="Settings" description="Changes apply immediately and are saved on this device." width="narrow">
      <Appearance />
      <DiagnosticsSection />
      <About />
    </Page>
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
    <Section id="appearance" title="Appearance">
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
      </div>
    </Section>
  );
}

function DiagnosticsSection() {
  const { data, error, refresh } = useDiagnostics();
  const { copyReport, openLogs, checkSecureStore, checking } = useDiagnosticsActions();

  return (
    <Section
      id="diagnostics"
      title="Diagnostics"
      description="Health information for support. Reports never include project files, prompts or credentials."
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
          items={[
            { key: "version", label: "Version", value: `${data.app.version} (${data.app.channel})` },
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
    </Section>
  );
}

function About() {
  const { info } = useRuntime();
  return (
    <Section id="about" title="About KalCode">
      <figure className={styles.about}>
        <img
          src={kalcodeGlobe362}
          srcSet={`${kalcodeGlobe362} 362w, ${kalcodeGlobe724} 724w`}
          sizes="10rem"
          width={362}
          height={362}
          alt="KalCode constellation globe with a K formed by connected points of light"
          className={styles.aboutGlobe}
        />
        <figcaption className={styles.aboutText}>
          <span className={styles.aboutLockup}>
            <Wordmark className={styles.aboutWordmark} />
            <KalCodeTagline className={styles.aboutTagline} />
          </span>
          <p className={styles.aboutMeta}>
            {info.channel === "stable" ? `Version ${info.version}` : `Version ${info.version}, ${info.channel} build`}
          </p>
        </figcaption>
      </figure>
    </Section>
  );
}
