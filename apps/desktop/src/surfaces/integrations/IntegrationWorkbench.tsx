import { Button } from "@kalcode/ui/components";
import { ArrowUp, PlugZap, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  INTEGRATION_APPROVAL_GRANTED,
  type IntegrationTurn,
  integrationDispatch,
  integrationError,
  type ToolScope,
} from "../../ipc/integrationClient.ts";
import styles from "./IntegrationHub.module.css";

/** Same canonical tool system for Code, KalVoice, and future workflow adapters. */
export function IntegrationWorkbench({ scope }: { scope: ToolScope | null }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IntegrationTurn | null>(null);
  const [approvedId, setApprovedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<{ configured: boolean; model: string } | null>(null);
  const [model, setModel] = useState("");
  const key = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);
  const identity = scope ? `${scope.workspace_id}:${scope.surface}:${scope.session_id}` : "";
  const scopeIdentity = useRef(identity);
  useEffect(() => {
    scopeIdentity.current = identity;
    ++epoch.current;
    setResult(null);
    setApprovedId(null);
    setError(null);
    setBusy(false);
    return () => {
      ++epoch.current;
    };
  }, [identity]);
  useEffect(() => {
    const onApproved = (event: Event) => {
      const id = (event as CustomEvent<unknown>).detail;
      if (typeof id === "string" && result?.status === "approval_required" && id === result.approval.id)
        setApprovedId(id);
    };
    window.addEventListener(INTEGRATION_APPROVAL_GRANTED, onApproved);
    return () => window.removeEventListener(INTEGRATION_APPROVAL_GRANTED, onApproved);
  }, [result]);
  useEffect(() => {
    let live = true;
    void integrationDispatch<{ configured: boolean; model: string }>("openai_status")
      .then((status) => {
        if (live) {
          setConfig(status);
          setModel(status.model);
        }
      })
      .catch((e) => {
        if (live) setError(integrationError(e));
      });
    return () => {
      live = false;
    };
  }, []);
  async function run(action: () => Promise<IntegrationTurn>) {
    if (busy) return;
    const started = epoch.current;
    setBusy(true);
    setError(null);
    try {
      const turn = await action();
      if (epoch.current === started) setResult(turn);
    } catch (e) {
      if (epoch.current === started) setError(integrationError(e));
    } finally {
      if (epoch.current === started) setBusy(false);
    }
  }
  async function configure(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const credential = key.current?.value ?? "";
    if (key.current) key.current.value = "";
    try {
      await integrationDispatch("openai_configure", { credential, model: model.trim() });
      setConfig(await integrationDispatch("openai_status"));
    } catch (e) {
      setError(integrationError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.workbench} aria-label="Ask connected tools">
      <div className={styles.listHeading}>
        <h3>
          <PlugZap size={15} aria-hidden="true" /> Ask your connected tools
        </h3>
        <span className={styles.health}>
          <ShieldCheck size={13} /> Scoped access
        </span>
      </div>
      <p className={styles.help}>
        Use the tools allowed for this session. Reads run directly; sensitive actions require your approval.
      </p>
      <form
        className={styles.query}
        onSubmit={(e) => {
          e.preventDefault();
          if (scope && prompt.trim())
            void run(() => integrationDispatch<IntegrationTurn>("query", { scope, prompt: prompt.trim() }));
        }}
      >
        <label>
          Request
          <textarea
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Check the latest GitHub issue or deployment status…"
            disabled={busy}
          />
        </label>
        <Button
          variant="primary"
          type="submit"
          icon={<ArrowUp />}
          busy={busy}
          disabled={!scope || !prompt.trim() || !config?.configured}
        >
          Ask tools
        </Button>
      </form>
      {!scope && <p className={styles.help}>Select a workspace and coding agent to use its tools.</p>}
      {result?.status === "completed" && (
        <div className={styles.result} role="status">
          {result.text}
        </div>
      )}
      {result?.status === "approval_required" && (
        <div className={styles.approval}>
          <h3>Review external action</h3>
          <p>
            <strong>{result.approval.integration_name}</strong> wants to run{" "}
            <strong>{result.approval.tool_name}</strong>.
          </p>
          <pre>{JSON.stringify(result.approval.arguments_preview, null, 2)}</pre>
          <p>
            Approval applies once to these exact arguments. Expires{" "}
            {new Date(result.approval.expires_at_ms).toLocaleTimeString()}.
          </p>
          <div className={styles.actions}>
            <Button
              disabled={busy || Date.now() >= result.approval.expires_at_ms}
              onClick={() => {
                const pending = result;
                if (scope)
                  void run(async () => {
                    if (approvedId !== pending.approval.id)
                      await integrationDispatch("approve", { approval_id: pending.approval.id });
                    return integrationDispatch<IntegrationTurn>("resume", { scope, turn_id: pending.turn_id });
                  });
              }}
            >
              {approvedId === result.approval.id ? "Continue approved action" : "Review and approve"}
            </Button>
            <Button disabled={busy} onClick={() => setResult(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <details className={styles.config} open={config?.configured === false ? true : undefined}>
        <summary>
          {config?.configured ? `OpenAI · ${config.model} · API key saved` : "Connect your OpenAI API account"}
        </summary>
        <p className={styles.help}>
          Available on every KalCode plan. API usage is billed to your own OpenAI account. The key is kept in your OS
          credential store.
        </p>
        <form onSubmit={(e) => void configure(e)}>
          <label>
            OpenAI API key
            <input ref={key} type="password" autoComplete="new-password" required placeholder="Enter your API key" />
          </label>
          <label>
            Model
            <input
              required
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Supported Responses model"
            />
          </label>
          <Button type="submit" disabled={busy}>
            Save API connection
          </Button>
          {config?.configured && (
            <Button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void integrationDispatch("openai_configure", { credential: null, model: config.model })
                  .then(() => {
                    setConfig({ configured: false, model: config.model });
                    setResult(null);
                  })
                  .catch((error) => setError(integrationError(error)))
                  .finally(() => setBusy(false));
              }}
            >
              Disconnect OpenAI
            </Button>
          )}
        </form>
      </details>
    </section>
  );
}
