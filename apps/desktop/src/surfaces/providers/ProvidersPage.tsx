import type { ProviderStatus } from "@kalcode/protocol";
import {
  Badge,
  Button,
  ErrorState,
  IconButton,
  type KeyValueItem,
  KeyValueList,
  Section,
  Skeleton,
  StatusIndicator,
  useToast,
} from "@kalcode/ui/components";
import { Check, Copy, Minus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { Page } from "../../shell/Page.tsx";
import styles from "./ProvidersPage.module.css";
import {
  adapterLabel,
  authLabel,
  capabilityItems,
  detectionLabel,
  fidelityLabel,
  type Label,
  modeLabel,
  modelList,
  needsInstall,
  needsSignIn,
  settingGroups,
} from "./providerLabels.ts";
import { useProviders } from "./useProviders.ts";

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function ProvidersPage() {
  const { statuses, listError, retryList, detect, detecting, detectError } = useProviders();
  const now = useNow();
  const lastChecked = latestCheck(statuses);

  return (
    <Page
      title="Providers"
      description="KalCode runs each provider through its own command-line tool, signed in with your own account, subscription or API key. KalCode never pays for or proxies your AI usage."
      actions={
        <div className={styles.headerActions}>
          <p className={styles.checked} role="status">
            {detecting ? "Checking providers…" : lastChecked ? `Checked ${formatRelative(lastChecked, now)}` : ""}
          </p>
          <Button icon={<RefreshCw />} onClick={() => void detect()} busy={detecting} disabled={!statuses}>
            Check again
          </Button>
        </div>
      }
    >
      {listError && !statuses ? (
        <ErrorState
          title="Providers couldn't load"
          code={`${listError.category}/${listError.code}`}
          actions={<Button onClick={retryList}>Try again</Button>}
        >
          <p>{listError.message}</p>
        </ErrorState>
      ) : !statuses ? (
        <div role="status" aria-busy="true" className={styles.loading}>
          <span className="visually-hidden">Loading providers</span>
          <Skeleton width="30%" height="1rem" />
          <Skeleton width="65%" />
          <Skeleton width="55%" />
          <Skeleton width="60%" />
        </div>
      ) : (
        <>
          {detectError ? (
            <ErrorState
              title="Couldn't check providers"
              code={`${detectError.category}/${detectError.code}`}
              actions={
                <Button onClick={() => void detect()} busy={detecting}>
                  Try again
                </Button>
              }
            >
              <p>{detectError.message} Nothing on your system was changed.</p>
            </ErrorState>
          ) : null}
          {statuses.map((status) => (
            <ProviderSection key={status.id} status={status} checking={detecting} now={now} />
          ))}
        </>
      )}
    </Page>
  );
}

function latestCheck(statuses: readonly ProviderStatus[] | null): string | null {
  const times = (statuses ?? []).flatMap((s) => (s.detection ? [s.detection.checkedAt] : []));
  return times.sort().at(-1) ?? null;
}

function StatusValue({ label }: { label: Label }) {
  return (
    <span className={styles.status}>
      <StatusIndicator tone={label.tone}>{label.label}</StatusIndicator>
      {label.detail ? <span className={styles.statusDetail}>{label.detail}</span> : null}
    </span>
  );
}

function ProviderSection({ status, checking, now }: { status: ProviderStatus; checking: boolean; now: number }) {
  const sectionId = `provider-${status.id}`;
  const adapter = adapterLabel(status.adapter);
  const detection = status.detection;
  const auth = authLabel(status);

  const setup: KeyValueItem[] = [
    {
      key: "status",
      label: "Status",
      value:
        !detection && checking ? (
          <span role="status" aria-busy="true" className={styles.pending}>
            <span className="visually-hidden">Checking {status.displayName}</span>
            <Skeleton width="9rem" />
          </span>
        ) : (
          <StatusValue label={detectionLabel(detection, status.detectionErrorCode)} />
        ),
    },
  ];
  if (auth) setup.push({ key: "auth", label: "Sign-in", value: <StatusValue label={auth} /> });
  if (needsSignIn(status)) {
    setup.push({
      key: "sign-in",
      label: "How to sign in",
      value: (
        <span className={styles.prose}>
          Run <code data-selectable>{status.signInCommand}</code> in a terminal to sign in to {status.displayName} with
          your own account, then choose Check again.
        </span>
      ),
    });
  }
  if (detection?.displayPath) {
    setup.push({ key: "path", label: "Location", value: <code data-selectable>{detection.displayPath}</code> });
  }
  if (needsInstall(status)) {
    setup.push({
      key: "install",
      label: "Install",
      value: <InstallCommand status={status} />,
    });
  }
  if (detection) {
    setup.push({
      key: "checked",
      label: "Last checked",
      value: (
        <time dateTime={detection.checkedAt} title={formatAbsolute(detection.checkedAt)}>
          {formatRelative(detection.checkedAt, now)}
        </time>
      ),
    });
  }

  const models = modelList(status);
  const details: KeyValueItem[] = [
    { key: "integration", label: "Integration", value: status.integration },
    { key: "capabilities", label: "Capabilities", value: <Capabilities status={status} /> },
    {
      key: "models",
      label: "Models",
      value: models ?? <span className={styles.muted}>Not listed without starting a session</span>,
    },
    {
      key: "docs",
      label: "Documentation",
      value: (
        <span data-selectable className={styles.url}>
          {status.docsUrl}
        </span>
      ),
    },
  ];

  return (
    <Section
      id={sectionId}
      title={status.displayName}
      description={adapter.description}
      actions={<Badge tone={status.adapter === "implemented" ? "accent" : "outline"}>{adapter.badge}</Badge>}
    >
      <div className={styles.overview}>
        <KeyValueList items={setup} className={styles.kv} />
        <KeyValueList items={details} className={styles.kv} />
      </div>
      <MappingTable status={status} />
    </Section>
  );
}

function InstallCommand({ status }: { status: ProviderStatus }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(status.installCommand);
      toast.show({
        tone: "success",
        title: "Install command copied",
        description: "Paste it into a terminal. KalCode never runs it for you.",
      });
    } catch (error) {
      toast.show({
        tone: "danger",
        title: "Couldn't copy the install command",
        description: toKalCodeError(error).message,
      });
    }
  };
  return (
    <span className={styles.install}>
      <span className={styles.commandLine}>
        <code data-selectable className={styles.command}>
          {status.installCommand}
        </code>
        <IconButton
          size="sm"
          label={`Copy install command for ${status.displayName}`}
          icon={<Copy />}
          onClick={() => void copy()}
        />
      </span>
      <span className={styles.statusDetail}>
        From the official {status.displayName} documentation. Run it in a terminal, then choose Check again.
      </span>
    </span>
  );
}

function Capabilities({ status }: { status: ProviderStatus }) {
  return (
    <ul className={styles.capabilities} aria-label={`${status.displayName} capabilities in KalCode`}>
      {capabilityItems(status.capabilities).map((item) => (
        <li key={item.key} className={styles.capability} data-supported={item.supported}>
          {item.supported ? <Check aria-hidden="true" /> : <Minus aria-hidden="true" />}
          <span>{item.label}</span>
          <span className={styles.capabilityValue}>{item.supported ? "Yes" : "No"}</span>
        </li>
      ))}
    </ul>
  );
}

function MappingTable({ status }: { status: ProviderStatus }) {
  const mappings = status.capabilities.permissionMappings;
  if (mappings.length === 0) return null;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className={styles.caption}>
          <span className={styles.captionTitle}>Permission modes in {status.displayName}</span>
          <span className={styles.captionText}>
            The setting KalCode passes for each mode. When {status.displayName} can't match a mode exactly, KalCode uses
            a stricter setting, never a broader one.
          </span>
        </caption>
        <colgroup>
          <col className={styles.colMode} />
          <col className={styles.colSetting} />
          <col className={styles.colFidelity} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">KalCode mode</th>
            <th scope="col">{status.displayName} setting</th>
            <th scope="col">Fidelity</th>
            <th scope="col">What happens</th>
          </tr>
        </thead>
        <tbody>
          {mappings.map((mapping) => (
            <tr key={mapping.mode}>
              <th scope="row">{modeLabel(mapping.mode)}</th>
              <td>
                <code data-selectable className={styles.setting}>
                  {settingGroups(mapping.providerSetting).map((group, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: groups are static text; a flag may repeat.
                    <span key={index} className={styles.flag}>
                      {group}
                    </span>
                  ))}
                </code>
              </td>
              <td>{fidelityLabel(mapping.fidelity)}</td>
              <td className={styles.notes}>{mapping.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
