import type { ProviderAccount, ProviderStatus } from "@kalcode/protocol";
import {
  Badge,
  Button,
  ErrorState,
  IconButton,
  type KeyValueItem,
  KeyValueList,
  Panel,
  ProviderMark,
  Skeleton,
  StatusIndicator,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from "@kalcode/ui/components";
import { Check, CircleDashed, Copy, LogIn, Minus, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { Page } from "../../shell/Page.tsx";
import { useOptionalProviderAccountSessions } from "./ProviderAccountSessions.tsx";
import { ProviderAccountsView, type ProviderSignInRequest } from "./ProviderAccountsView.tsx";
import { ProviderHealthView } from "./ProviderHealthView.tsx";
import styles from "./ProvidersPage.module.css";
import {
  accountSignInHint,
  adapterLabel,
  authLabel,
  capabilityItems,
  detectionLabel,
  fidelityLabel,
  type Label,
  managedSignInLabel,
  modeLabel,
  modelList,
  needsInstall,
  needsSignIn,
  settingGroups,
  toolItems,
} from "./providerLabels.ts";
import { consumeProvidersTab, type ProvidersTab, useProvidersTabRequest } from "./providersTab.ts";
import { isBrowserAuthProvider } from "./useProviderAccounts.ts";
import { useProviderHealth } from "./useProviderHealth.ts";
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
  const request = useProvidersTabRequest();
  // Accounts first: it is where sign-in and usage live, and it opens without a provider check.
  const [tab, setTab] = useState<ProvidersTab>(request?.tab ?? "accounts");
  const [signInRequest, setSignInRequest] = useState<ProviderSignInRequest | null>(null);
  // Setup reads sign-in from the same canonical accounts the Accounts tab shows.
  const accounts = useOptionalProviderAccountSessions()?.accounts ?? null;
  const requestSignIn = useCallback((providerId: string) => {
    setTab("accounts");
    setSignInRequest((current) => ({ providerId, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);
  // Accounts reads it too, for provider-wide rate limits on each provider's section.
  const health = useProviderHealth(tab === "health" || tab === "accounts");
  const { refresh: refreshHealth } = health;

  // "Health details" on the Dashboard (or any other place) asked for a tab.
  useEffect(() => {
    if (!request) return;
    setTab(request.tab);
    consumeProvidersTab(request.nonce);
  }, [request]);

  // A finished check (first visit or Check again) also refreshes health.
  const wasDetecting = useRef(detecting);
  useEffect(() => {
    if (wasDetecting.current && !detecting) refreshHealth();
    wasDetecting.current = detecting;
  }, [detecting, refreshHealth]);

  return (
    <Page
      title="Providers"
      description="KalCode runs each provider through its own command-line tool, signed in with your own provider account. KalCode never pays for or proxies your AI usage."
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
      <Tabs value={tab} onValueChange={(value) => setTab(value as ProvidersTab)} className={styles.tabs}>
        <TabsList aria-label="Provider views">
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="health">Health</TabsTrigger>
        </TabsList>
        <TabsContent value="setup" className={styles.tabPanel}>
          {listError && !statuses ? (
            <ErrorState
              title="Providers couldn't load"
              code={`${listError.category}/${listError.code}`}
              actions={<Button onClick={retryList}>Try again</Button>}
            >
              <p>{listError.message}</p>
            </ErrorState>
          ) : !statuses ? (
            <Panel as="div" className={styles.loading} role="status" aria-busy="true">
              <span className="visually-hidden">Loading providers</span>
              <Skeleton width="30%" height="1rem" />
              <Skeleton width="65%" />
              <Skeleton width="55%" />
              <Skeleton width="60%" />
            </Panel>
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
                <ProviderSection
                  key={status.id}
                  status={status}
                  checking={detecting}
                  now={now}
                  accounts={accounts ? accounts.filter((account) => account.providerId === status.id) : null}
                  onSignIn={requestSignIn}
                />
              ))}
            </>
          )}
        </TabsContent>
        <TabsContent value="accounts" className={styles.tabPanel}>
          <section aria-label="Provider accounts" className={styles.tabPanel}>
            <ProviderAccountsView
              enabled={tab === "accounts"}
              statuses={statuses}
              health={health.list}
              signInRequest={signInRequest}
            />
          </section>
        </TabsContent>
        <TabsContent value="health" className={styles.tabPanel}>
          <section aria-label="Provider health" className={styles.tabPanel}>
            <ProviderHealthView data={health} statuses={statuses} now={now} />
          </section>
        </TabsContent>
      </Tabs>
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

function ProviderSection({
  status,
  checking,
  now,
  accounts,
  onSignIn,
}: {
  status: ProviderStatus;
  checking: boolean;
  now: number;
  /** This provider's KalCode accounts; null while they load. */
  accounts: readonly ProviderAccount[] | null;
  onSignIn: (providerId: string) => void;
}) {
  const sectionId = `provider-${status.id}`;
  const adapter = adapterLabel(status.adapter);
  const detection = status.detection;
  // A managed provider signs in per KalCode account, so its accounts are the one authority. The
  // CLI's own standalone login (what detection checks) is a different profile KalCode doesn't use.
  const managed = isBrowserAuthProvider(status.id);
  const installed = detection !== null && detection.state !== "not_installed" && detection.state !== "error";
  const auth = managed ? (installed ? managedSignInLabel(accounts) : null) : authLabel(status);

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
  if (managed && installed) {
    const signedIn = accounts?.some((account) => account.authenticationState === "authenticated") ?? false;
    setup.push({
      key: "auth",
      label: "Sign-in",
      value: signedIn ? (
        <StatusValue label={auth as Label} />
      ) : (
        <span className={styles.signIn}>
          <span className={styles.signInLine}>
            {auth ? <StatusIndicator tone={auth.tone}>{auth.label}</StatusIndicator> : <Skeleton width="7rem" />}
            <Button
              size="sm"
              variant="primary"
              icon={accounts?.length === 0 ? <Plus /> : <LogIn />}
              onClick={() => onSignIn(status.id)}
              aria-label={`${accounts?.length === 0 ? "Add" : "Sign in to"} ${status.displayName} account`}
            >
              {accounts?.length === 0 ? "Add account" : "Sign in"}
            </Button>
          </span>
          <span className={styles.statusDetail}>{accountSignInHint(status)}</span>
        </span>
      ),
    });
  } else if (auth) setup.push({ key: "auth", label: "Sign-in", value: <StatusValue label={auth} /> });
  if (!managed && needsSignIn(status)) {
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
    ...(status.capabilities.tools.length > 0
      ? [{ key: "tools", label: "Tools in KalCode", value: <ToolList status={status} /> }]
      : []),
    {
      key: "models",
      label: "Models",
      value: models ?? (
        <span className={styles.muted}>
          {status.id === "cursor"
            ? "Discovered from your Cursor account when launching an agent"
            : "Not listed without starting a session"}
        </span>
      ),
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
    <Panel
      id={sectionId}
      className={styles.provider}
      title={<ProviderMark provider={status.id} name={status.displayName} tile size="md" />}
      description={adapter.description}
      // "Adapter ready" beside "Not installed" reads as a contradiction; the status row says it all.
      actions={
        needsInstall(status) ? null : (
          <Badge tone={status.adapter === "implemented" ? "accent" : "outline"}>{adapter.badge}</Badge>
        )
      }
      padding="none"
    >
      <div className={styles.overview}>
        <KeyValueList items={setup} className={styles.kv} />
        <KeyValueList items={details} className={styles.kv} />
      </div>
      <MappingTable status={status} />
    </Panel>
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

/** The provider's native tools inside KalCode, as its adapter declares them. */
function ToolList({ status }: { status: ProviderStatus }) {
  return (
    <ul className={styles.tools} aria-label={`${status.displayName} tools in KalCode`}>
      {toolItems(status.capabilities).map((item) => (
        <li
          key={item.kind}
          className={styles.toolItem}
          data-state={item.state}
          data-provider-tool={item.kind}
          title={item.detail ?? undefined}
        >
          {item.state === "native" ? (
            <Check aria-hidden="true" />
          ) : item.state === "needs_setup" ? (
            <CircleDashed aria-hidden="true" />
          ) : (
            <Minus aria-hidden="true" />
          )}
          <span>{item.label}</span>
          <span className={styles.toolState}>{item.value}</span>
          {item.state !== "native" && item.detail ? <span className={styles.toolDetail}>{item.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The exact flags KalCode passes per mode. Reference detail, so it is collapsed: the setup facts
 * above it (and the next provider) stay on the first screen.
 */
function MappingTable({ status }: { status: ProviderStatus }) {
  const mappings = status.capabilities.permissionMappings;
  if (mappings.length === 0) return null;
  return (
    <details className={styles.mappings}>
      <summary className={styles.mappingsSummary}>Permission modes in {status.displayName}</summary>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className={styles.caption}>
            <span className={styles.captionTitle}>Permission modes in {status.displayName}</span>
            <span className={styles.captionText}>
              The setting KalCode passes for each mode. When {status.displayName} can't match a mode exactly, KalCode
              uses a stricter setting, never a broader one.
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
                <th scope="row">
                  <span className={styles.mode} data-mode={mapping.mode}>
                    {modeLabel(mapping.mode)}
                  </span>
                </th>
                <td>
                  <code data-selectable className={styles.setting}>
                    {settingGroups(mapping.providerSetting).map((group, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: groups are static text; a flag may repeat.
                      <span key={index} className={styles.flag}>
                        {withCommaBreaks(group)}
                      </span>
                    ))}
                  </code>
                </td>
                <td>
                  <span className={styles.fidelity} data-fidelity={mapping.fidelity}>
                    {fidelityLabel(mapping.fidelity)}
                  </span>
                </td>
                <td className={styles.notes}>{mapping.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Long comma lists ("Edit,Write,…") may wrap after a comma, never inside a name. */
function withCommaBreaks(text: string) {
  const parts = text.split(",");
  return parts.map((part, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: static text fragments in a fixed order.
    <span key={index}>
      {part}
      {index < parts.length - 1 ? (
        <>
          ,<wbr />
        </>
      ) : null}
    </span>
  ));
}
