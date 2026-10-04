import { Button, Skeleton } from "@kalcode/ui/components";
import {
  ArrowUpRight,
  Cable,
  Check,
  ChevronRight,
  Globe,
  LockKeyhole,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Unplug,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  type CustomTool,
  type Integration,
  type IntegrationApproval,
  type IntegrationInput,
  integrationClient,
  integrationDispatch,
  integrationError,
  type ToolScope,
} from "../../ipc/integrationClient.ts";
import styles from "./IntegrationHub.module.css";

export interface ScopeChoice {
  label: string;
  scope: ToolScope;
}
const KIND_LABEL = { remote_mcp: "Remote MCP", custom_api: "Custom API", secure_mcp_tunnel: "Secure MCP Tunnel" };
const HEALTH_LABEL = {
  unknown: "Not checked",
  healthy: "Healthy",
  offline: "Offline",
  auth_expired: "Reconnect needed",
  error: "Needs attention",
};
const EXAMPLE_TOOLS = JSON.stringify(
  [
    {
      name: "get_deployment_status",
      description: "Read the current deployment status",
      method: "GET",
      path: "/status",
      risk: "read",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  ],
  null,
  2,
);

export function sameScope(a: ToolScope, b: ToolScope) {
  return a.workspace_id === b.workspace_id && a.surface === b.surface && a.session_id === b.session_id;
}

export function IntegrationHub({ scopes = [] }: { scopes?: ScopeChoice[] }) {
  const [items, setItems] = useState<Integration[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState<IntegrationInput | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const alive = useRef(true);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await integrationClient.list();
      if (alive.current && current === generation.current) {
        setItems(next);
        setError(null);
      }
    } catch (e) {
      if (alive.current && current === generation.current) setError(integrationError(e));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, [reload]);
  async function act(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (e) {
      if (alive.current) setError(integrationError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const current = items?.find((item) => item.id === selected);
  const visible = items?.filter((item) =>
    `${item.name} ${KIND_LABEL[item.kind]}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <section className={styles.hub} aria-label="Integration Hub" id="integration-hub">
      <header className={styles.heading}>
        <div className={styles.identity}>
          <span className={styles.emblem}>
            <PlugZap size={23} />
          </span>
          <div>
            <h2>Integration Hub</h2>
            <p>Your development stack. Within reach.</p>
          </div>
        </div>
        <Button
          icon={<Plus />}
          variant="primary"
          onClick={() => {
            setConnecting(true);
            setReconnecting(undefined);
          }}
        >
          Connect a tool
        </Button>
      </header>
      <div className={styles.security}>
        <ShieldCheck size={15} />
        <span>Access is scoped to your workspace and agent. Sensitive actions stay in your control.</span>
      </div>
      <PendingApprovals />
      {error && (
        <div role="alert" className={styles.error}>
          <span>{error}</span>
          <Button onClick={() => void reload()} icon={<RefreshCw />}>
            Retry
          </Button>
        </div>
      )}
      {connecting ? (
        <ConnectionForm
          key={reconnecting?.id ?? "new"}
          existing={reconnecting}
          onCancel={() => {
            setConnecting(false);
            setReconnecting(undefined);
          }}
          onSave={async (input, credential) => {
            const saved = await integrationClient.save(input, credential);
            setConnecting(false);
            setSelected(saved.id);
            await reload();
            await act(() => integrationClient.refresh(saved.id));
          }}
        />
      ) : null}
      <div className={styles.body}>
        <div className={styles.connections}>
          <div className={styles.listHeading}>
            <h3>Connections{items ? <span>{items.length}</span> : null}</h3>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Refresh connections"
              onClick={() => void reload()}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          {(items?.length ?? 0) > 3 && (
            <label className={styles.search}>
              <Search size={15} />
              <input
                aria-label="Find a connection"
                placeholder="Find a connection"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </label>
          )}
          {!items && !error ? (
            <div role="status" aria-label="Loading integrations" className={styles.empty}>
              <Skeleton width="75%" />
              <Skeleton width="55%" />
              <Skeleton width="65%" />
            </div>
          ) : null}
          {items?.length === 0 && (
            <div className={styles.empty}>
              <Cable size={30} />
              <h3>Bring your tools closer.</h3>
              <p>Connect a trusted service or your own API, then choose exactly who can use it.</p>
              <Button onClick={() => setConnecting(true)}>
                Add your first connection <ArrowUpRight size={14} />
              </Button>
            </div>
          )}
          {visible?.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.connection}
              aria-pressed={selected === item.id}
              onClick={() => setSelected(item.id)}
            >
              <span className={styles.serviceIcon}>
                {item.kind === "secure_mcp_tunnel" ? (
                  <LockKeyhole size={19} />
                ) : item.kind === "custom_api" ? (
                  <Cable size={19} />
                ) : (
                  <Globe size={19} />
                )}
              </span>
              <span className={styles.connectionText}>
                <strong>{item.name}</strong>
                <small>
                  {KIND_LABEL[item.kind]} · {item.capabilities.length} tools
                </small>
              </span>
              <span className={styles.health} data-health={item.connected ? item.health : "disconnected"}>
                <i />
                {item.connected ? HEALTH_LABEL[item.health] : "Disconnected"}
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
          {items && items.length > 0 && visible?.length === 0 && (
            <p className={styles.empty}>No connections match “{filter}”.</p>
          )}
        </div>
        {current ? (
          <IntegrationDetail
            key={`${current.id}:${current.revision}`}
            integration={current}
            scopes={scopes}
            busy={busy}
            onAction={act}
            onReconnect={() => {
              void act(async () => {
                const configuration = await integrationClient.configuration(current.id);
                setReconnecting(configuration);
                setConnecting(true);
              });
            }}
          />
        ) : (
          <div className={styles.intro}>
            <span className={styles.orbit}>
              <PlugZap size={38} />
            </span>
            <h3>Connected to your workflow.</h3>
            <p>
              GitHub issues. Deployment status. Project documents. Connect once, then use the tools you allow from Code
              and KalVoice.
            </p>
            <div className={styles.introNote}>
              <LockKeyhole size={16} />
              <span>
                Credentials stay in your OS credential store. External results aren’t automatically saved to Memory.
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function PendingApprovals() {
  const [pending, setPending] = useState<IntegrationApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const approvals = await integrationDispatch<IntegrationApproval[]>("pending");
        if (live) setPending(approvals);
      } catch {
        /* The main list reports runtime failure. */
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  if (!pending.length) return null;
  return (
    <div className={styles.connectForm}>
      <h3>External actions awaiting approval</h3>
      {pending.map((approval) => (
        <div className={styles.approval} key={approval.id}>
          <p>
            <strong>{approval.integration_name}</strong> · {approval.tool_name}
          </p>
          <p>
            {approval.scope.surface} · Session {approval.scope.session_id}
          </p>
          <pre>{JSON.stringify(approval.arguments_preview, null, 2)}</pre>
          <Button
            disabled={!!busy || Date.now() >= approval.expires_at_ms}
            busy={busy === approval.id}
            onClick={() => {
              setBusy(approval.id);
              setError(null);
              void integrationDispatch("approve", { approval_id: approval.id })
                .then(() => setPending((items) => items.filter((item) => item.id !== approval.id)))
                .catch((e) => setError(integrationError(e)))
                .finally(() => setBusy(null));
            }}
          >
            Review and approve once
          </Button>
        </div>
      ))}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}

function ConnectionForm({
  existing,
  onCancel,
  onSave,
}: {
  existing?: IntegrationInput;
  onCancel: () => void;
  onSave: (input: IntegrationInput, credential: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<IntegrationInput["kind"]>(existing?.kind ?? "remote_mcp");
  const [name, setName] = useState(existing?.name ?? "");
  const [endpoint, setEndpoint] = useState(existing?.endpoint ?? "");
  const [tools, setTools] = useState(existing?.tools.length ? JSON.stringify(existing.tools, null, 2) : EXAMPLE_TOOLS);
  const [reads, setReads] = useState(existing?.trusted_read_tools.join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const credential = useRef<HTMLInputElement>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      let definitions: CustomTool[] = [];
      if (kind === "custom_api") {
        try {
          definitions = JSON.parse(tools) as CustomTool[];
        } catch {
          throw new Error("Tool definitions must be valid JSON. Check commas and quotation marks.");
        }
        if (!Array.isArray(definitions) || !definitions.length)
          throw new Error("Define at least one API tool before connecting.");
      }
      const secret = credential.current?.value ?? "";
      if (credential.current) credential.current.value = "";
      await onSave(
        {
          ...(existing ? { id: existing.id } : {}),
          name: name.trim(),
          endpoint: endpoint.trim(),
          kind,
          tools: definitions,
          trusted_read_tools: reads
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        },
        secret,
      );
    } catch (e) {
      setError(integrationError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className={styles.connectForm}
      aria-label={existing ? "Reconnect integration" : "Connect integration"}
    >
      <div className={styles.listHeading}>
        <h3>{existing ? `Reconnect ${existing.name}` : "Connect your tool"}</h3>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onCancel}
          aria-label="Close connection form"
          disabled={busy}
        >
          <X size={17} />
        </button>
      </div>
      <div className={styles.fields}>
        <label>
          Connection type
          <select
            value={kind}
            disabled={!!existing}
            onChange={(e) => setKind(e.target.value as IntegrationInput["kind"])}
          >
            <option value="remote_mcp">Remote MCP server</option>
            <option value="custom_api">Custom API</option>
            <option value="secure_mcp_tunnel">Private / local · Secure MCP Tunnel</option>
          </select>
        </label>
        <label>
          Name
          <input
            required
            maxLength={80}
            autoComplete="off"
            placeholder="e.g. Production deploys"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className={styles.fullWidth}>
          {kind === "secure_mcp_tunnel" ? "Secure MCP Tunnel ID" : "Server URL"}
          <input
            required
            type={kind === "secure_mcp_tunnel" ? "text" : "url"}
            placeholder={kind === "secure_mcp_tunnel" ? "tunnel_…" : "https://api.example.com/mcp"}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className={styles.fullWidth}>
          Access token <span className={styles.optional}>Optional for public servers</span>
          <input
            ref={credential}
            type="password"
            autoComplete="new-password"
            placeholder="Stored securely on this device"
          />
        </label>
      </div>
      {kind === "secure_mcp_tunnel" && (
        <p className={styles.help}>
          Create a Secure MCP Tunnel with OpenAI’s supported tunnel client on the machine running your server. Use its
          tunnel ID here. Calls use your own OpenAI API account through Code’s Tools panel or KalVoice; the private
          server needs no public inbound port. Private tunnel tools are not exposed directly to provider terminals.
        </p>
      )}
      {kind === "custom_api" && (
        <label className={styles.schemaLabel}>
          Tool definitions
          <textarea
            value={tools}
            onChange={(e) => setTools(e.target.value)}
            rows={10}
            spellCheck={false}
            aria-describedby="integration-schema-help"
          />
          <small id="integration-schema-help">
            Only these named operations can run. Use strict JSON object schemas, explicit HTTP paths, and “read” or
            “sensitive” risk.
          </small>
        </label>
      )}
      {kind === "remote_mcp" && (
        <details className={styles.advanced}>
          <summary>Advanced · trusted read operations</summary>
          <p>
            Review the provider’s documentation before marking operations as reads. All other MCP operations require
            approval, regardless of server annotations.
          </p>
          <label>
            Read tool names
            <input value={reads} onChange={(e) => setReads(e.target.value)} placeholder="get_issue, list_deployments" />
          </label>
        </details>
      )}
      <p className={styles.help}>
        Use the service provider’s official server whenever available. Connect only servers you trust. Use a scoped
        access token issued by that service; never enter your account password.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Button variant="primary" type="submit" busy={busy}>
          Connect securely
        </Button>
        <Button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function IntegrationDetail({
  integration: item,
  scopes,
  busy,
  onAction,
  onReconnect,
}: {
  integration: Integration;
  scopes: ScopeChoice[];
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
  onReconnect: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [scopeIndex, setScopeIndex] = useState("");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const scope = scopes[Number(scopeIndex)]?.scope;
  const chooseScope = (value: string) => {
    setScopeIndex(value);
    const chosen = scopes[Number(value)]?.scope;
    setSelectedTools(chosen ? (item.grants.find((grant) => sameScope(grant, chosen))?.tool_names ?? []) : []);
  };
  return (
    <div className={styles.detail}>
      <div className={styles.listHeading}>
        <h3>Connection details</h3>
        <span className={styles.health} data-health={item.connected ? item.health : "disconnected"}>
          <i />
          {item.connected ? HEALTH_LABEL[item.health] : "Disconnected"}
        </span>
      </div>
      <form
        className={styles.rename}
        onSubmit={(e) => {
          e.preventDefault();
          void onAction(() => integrationClient.rename(item.id, name.trim()));
        }}
      >
        <label>
          Name
          <input
            aria-label="Integration name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
          />
        </label>
        <Button type="submit" disabled={busy || name.trim() === item.name || !name.trim()} icon={<Check />}>
          Save
        </Button>
      </form>
      <p className={styles.endpoint}>{item.endpoint}</p>
      {item.status_message && <p className={styles.help}>{item.status_message}</p>}
      <p className={styles.checked}>
        {item.last_checked_ms
          ? `Last checked ${new Date(item.last_checked_ms).toLocaleString()}`
          : "Connection health has not been checked yet."}
      </p>
      <div className={styles.actions}>
        <Button
          disabled={busy}
          icon={<RefreshCw />}
          onClick={() => void onAction(() => integrationClient.refresh(item.id))}
        >
          Check connection
        </Button>
        <Button disabled={busy} onClick={onReconnect}>
          Reconnect
        </Button>
        {item.connected && (
          <Button
            disabled={busy}
            icon={<Unplug />}
            onClick={() => void onAction(() => integrationClient.disconnect(item.id))}
          >
            Disconnect
          </Button>
        )}
      </div>
      {item.kind !== "secure_mcp_tunnel" && <OAuthSetup id={item.id} busy={busy} onAction={onAction} />}
      <div className={styles.sectionHeading}>
        <h3>Available tools</h3>
        <span>{item.capabilities.length}</span>
      </div>
      {!item.capabilities.length && (
        <p className={styles.help}>No capabilities discovered yet. Check the connection to retrieve its real tools.</p>
      )}
      <div className={styles.tools}>
        {item.capabilities.map((tool) => (
          <details key={tool.name} className={styles.tool}>
            <summary>
              <span>{tool.name}</span>
              <span className={styles.risk}>{tool.risk === "read" ? "Read" : "Approval required"}</span>
            </summary>
            <p>{tool.description}</p>
            <pre>{JSON.stringify(tool.input_schema, null, 2)}</pre>
          </details>
        ))}
      </div>
      <div className={styles.sectionHeading}>
        <h3>Workspace access</h3>
        <ShieldCheck size={16} />
      </div>
      <p className={styles.help}>
        Choose a specific workspace and session, then allow individual tools. New coding agents start with no access.
      </p>
      <label className={styles.scopeLabel}>
        Workspace / agent or workflow
        <select value={scopeIndex} onChange={(e) => chooseScope(e.target.value)}>
          <option value="">Choose where tools are available</option>
          {scopes.map((choice, index) => (
            <option
              key={`${choice.scope.workspace_id}:${choice.scope.surface}:${choice.scope.session_id}`}
              value={index}
            >
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      {scopeIndex !== "" && scope && (
        <>
          <div className={styles.toolChoices}>
            {item.capabilities.map((tool) => (
              <label key={tool.name}>
                <input
                  type="checkbox"
                  checked={selectedTools.includes(tool.name)}
                  onChange={(e) =>
                    setSelectedTools((current) =>
                      e.target.checked ? [...current, tool.name] : current.filter((name) => name !== tool.name),
                    )
                  }
                />
                <span>{tool.name}</span>
                <small>{tool.risk === "read" ? "Read" : "Approval required"}</small>
              </label>
            ))}
          </div>
          <Button
            disabled={busy || !item.connected}
            onClick={() =>
              void onAction(() =>
                integrationClient.grants(item.id, [
                  ...item.grants.filter((grant) => !sameScope(grant, scope)),
                  ...(selectedTools.length ? [{ ...scope, tool_names: selectedTools }] : []),
                ]),
              )
            }
          >
            Save access
          </Button>
        </>
      )}
      {item.grants.length > 0 && (
        <div className={styles.grants}>
          {item.grants.map((grant) => (
            <div key={`${grant.workspace_id}:${grant.surface}:${grant.session_id}`}>
              <span>
                {scopes.find((choice) => sameScope(choice.scope, grant))?.label ??
                  `${grant.surface} · ${grant.session_id}`}
                <small>{grant.tool_names.length} tools allowed</small>
              </span>
              <button
                className={styles.textButton}
                type="button"
                disabled={busy}
                onClick={() =>
                  void onAction(() =>
                    integrationClient.grants(
                      item.id,
                      item.grants.filter((entry) => !sameScope(entry, grant)),
                    ),
                  )
                }
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OAuthSetup({
  id,
  busy,
  onAction,
}: {
  id: string;
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [authorization, setAuthorization] = useState("");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [scopes, setScopes] = useState("");
  return (
    <details className={styles.advanced}>
      <summary>Sign in with your browser · OAuth setup</summary>
      <p>
        Use the authorization details supplied by your service provider. Register a desktop OAuth client that supports a
        loopback redirect. KalCode opens the provider’s sign-in page and uses PKCE.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onAction(() =>
            integrationDispatch("oauth", {
              id,
              config: {
                authorization_endpoint: authorization.trim(),
                token_endpoint: token.trim(),
                client_id: clientId.trim(),
                scopes: scopes.split(/\s+/).filter(Boolean),
              },
            }),
          );
        }}
      >
        <div className={styles.fields}>
          <label className={styles.fullWidth}>
            Authorization URL
            <input type="url" required value={authorization} onChange={(e) => setAuthorization(e.target.value)} />
          </label>
          <label className={styles.fullWidth}>
            Token URL
            <input type="url" required value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <label>
            Registered client ID
            <input required value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </label>
          <label>
            Scopes (space-separated)
            <input value={scopes} onChange={(e) => setScopes(e.target.value)} />
          </label>
        </div>
        <div className={styles.actions} style={{ marginTop: 14 }}>
          <Button type="submit" busy={busy}>
            Sign in with browser
          </Button>
        </div>
      </form>
    </details>
  );
}
