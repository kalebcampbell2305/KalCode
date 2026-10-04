import { ProviderGlyph } from "@kalcode/ui/components";
import { ArrowUp, Camera, Crosshair, Globe, LoaderCircle, Sparkles, TriangleAlert, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { dispatchPaneCommand } from "../../shell/panes/paneCommands.ts";
import styles from "./BrowserPane.module.css";
import type { BrowserScreenshot, PickedElement } from "./browserBridge.ts";
import { agentLabel, type LiveBrowserAgent } from "./liveBrowser.ts";
import type { LiveBrowserServices } from "./useLiveBrowserServices.ts";

export interface BrowserAskProps {
  workspaceId: string;
  services: LiveBrowserServices;
  preferredAgentId: string | null;
  page: { url: string; title: string | null };
  picked: PickedElement | null;
  errors: readonly string[];
  errorCount: number;
  screenshot: BrowserScreenshot | null;
  capturing: boolean;
  picking: boolean;
  onPick: () => void;
  onScreenshot: () => void;
  onRemovePicked: () => void;
  onRemoveScreenshot: () => void;
  /** Sends the question with the context; resolves once the agent's terminal has it. */
  onSend: (agent: LiveBrowserAgent, question: string, options: { includeErrors: boolean }) => Promise<void>;
  onClose: () => void;
}

/** "button.cta" from "main > div.hero > button.cta": the part a person recognizes. */
function shortSelector(selector: string): string {
  return selector.split(" > ").at(-1) ?? selector;
}

/**
 * Ask a coding agent about the page: the page, a picked element, console errors and a screenshot
 * ride along as removable context. Sending is one Enter; the prompt goes to the agent's terminal.
 */
export function BrowserAsk({
  workspaceId,
  services,
  preferredAgentId,
  page,
  picked,
  errors,
  errorCount,
  screenshot,
  capturing,
  picking,
  onPick,
  onScreenshot,
  onRemovePicked,
  onRemoveScreenshot,
  onSend,
  onClose,
}: BrowserAskProps) {
  const [agents, setAgents] = useState<LiveBrowserAgent[] | null>(null);
  const [agentId, setAgentId] = useState<string | null>(preferredAgentId);
  const [question, setQuestion] = useState("");
  const [includeErrors, setIncludeErrors] = useState(true);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void services.listAgents().then(
      (list) => {
        if (cancelled) return;
        setAgents(list);
        setAgentId((current) =>
          current && list.some((agent) => agent.threadId === current) ? current : (list[0]?.threadId ?? null),
        );
      },
      () => {
        if (!cancelled) setAgents([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [services]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const agent = agents?.find((candidate) => candidate.threadId === agentId) ?? null;
  const host = (() => {
    try {
      return new URL(page.url).host;
    } catch {
      return page.url;
    }
  })();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!agent || sending) return;
    setSending(true);
    setFailure(null);
    const text = question.trim() || (picked ? "What's wrong with this element?" : "What's wrong with this page?");
    // `onSend` closes the panel on success; a failure keeps the draft and says why.
    onSend(agent, text, { includeErrors }).then(
      () => {
        setSending(false);
        setQuestion("");
      },
      (cause) => {
        setSending(false);
        setFailure(toKalCodeError(cause, "browser_ask").message);
      },
    );
  };

  return (
    <section
      className={styles.askPanel}
      aria-label="Ask an agent about this page"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className={styles.panelHead}>
        <span className={styles.panelTitle}>
          <Sparkles size={13} aria-hidden="true" />
          Ask an agent
        </span>
        {agents !== null && agents.length === 0 ? null : (
          <span className={styles.agentPicker}>
            {agent ? <ProviderGlyph provider={agent.providerId} size="xs" /> : null}
            <select
              aria-label="Agent"
              className={styles.agentSelect}
              value={agentId ?? ""}
              disabled={!agents}
              onChange={(event) => setAgentId(event.currentTarget.value)}
            >
              {agents === null ? <option value="">Finding agents…</option> : null}
              {(agents ?? []).map((candidate) => (
                <option key={candidate.threadId} value={candidate.threadId}>
                  {agentLabel(candidate)}
                </option>
              ))}
            </select>
          </span>
        )}
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Close Ask Agent"
          title="Close Ask Agent"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      <ul className={styles.chips} aria-label="Context sent with your question">
        <li className={styles.chip} data-kind="page" title={page.url}>
          <Globe size={12} aria-hidden="true" />
          <span className={styles.chipText}>{page.title ? `${page.title} · ${host}` : host}</span>
        </li>
        {picked ? (
          <li className={styles.chip} data-kind="element" title={picked.selector}>
            <Crosshair size={12} aria-hidden="true" />
            <code className={styles.chipCode}>{shortSelector(picked.selector)}</code>
            <button type="button" className={styles.chipRemove} aria-label="Remove element" onClick={onRemovePicked}>
              <X size={12} strokeWidth={2.25} />
            </button>
          </li>
        ) : (
          <li>
            <button type="button" className={styles.chipAdd} onClick={onPick} aria-pressed={picking}>
              <Crosshair size={12} aria-hidden="true" />
              {picking ? "Picking… click the page" : "Pick element"}
            </button>
          </li>
        )}
        {errorCount > 0 ? (
          <li
            className={styles.chip}
            data-kind="errors"
            data-off={includeErrors ? undefined : "true"}
            title={errors.slice(-5).join("\n")}
          >
            <TriangleAlert size={12} aria-hidden="true" />
            <span className={styles.chipText}>
              {errorCount === 1 ? "1 console error" : `${errorCount} console errors`}
            </span>
            <button
              type="button"
              className={styles.chipRemove}
              aria-label={includeErrors ? "Leave out console errors" : "Include console errors"}
              onClick={() => setIncludeErrors((value) => !value)}
            >
              <X size={12} strokeWidth={2.25} />
            </button>
          </li>
        ) : null}
        {screenshot ? (
          <li className={styles.chip} data-kind="screenshot" title={screenshot.path}>
            <Camera size={12} aria-hidden="true" />
            <span className={styles.chipText}>Screenshot</span>
            <button
              type="button"
              className={styles.chipRemove}
              aria-label="Remove screenshot"
              onClick={onRemoveScreenshot}
            >
              <X size={12} strokeWidth={2.25} />
            </button>
          </li>
        ) : (
          <li>
            <button type="button" className={styles.chipAdd} onClick={onScreenshot} disabled={capturing}>
              {capturing ? (
                <LoaderCircle size={12} className={styles.spinner} aria-hidden="true" />
              ) : (
                <Camera size={12} aria-hidden="true" />
              )}
              Add screenshot
            </button>
          </li>
        )}
      </ul>
      {agents !== null && agents.length === 0 ? (
        <div className={styles.askEmpty}>
          <span>No coding agent is running in this workspace.</span>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => dispatchPaneCommand({ kind: "open-agent-launcher" }, { scope: workspaceId, queue: true })}
          >
            Launch an agent
          </button>
        </div>
      ) : (
        <form className={styles.askForm} onSubmit={submit}>
          <input
            ref={input}
            aria-label="Question"
            className={styles.askInput}
            value={question}
            placeholder={
              agent
                ? picked
                  ? `Ask ${agent.name} about ${shortSelector(picked.selector)}…`
                  : `Ask ${agent.name} about this page…`
                : "Ask about this page…"
            }
            onChange={(event) => setQuestion(event.currentTarget.value)}
          />
          <button
            type="submit"
            className={styles.sendButton}
            aria-label={agent ? `Send to ${agent.name}` : "Send"}
            title={agent ? `Send to ${agent.name}` : "Send"}
            disabled={!agent || sending}
          >
            {sending ? <LoaderCircle size={14} className={styles.spinner} /> : <ArrowUp size={15} />}
          </button>
        </form>
      )}
      {failure ? (
        <p className={styles.askFailure} role="alert">
          {failure}
        </p>
      ) : null}
    </section>
  );
}
