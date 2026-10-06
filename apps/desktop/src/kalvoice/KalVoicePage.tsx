import type { KalVoiceStatus } from "@kalcode/protocol";
import { Badge, Button, EmptyState, Section } from "@kalcode/ui/components";
import { AudioLines, MessageSquareText, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { toKalCodeError } from "../ipc/errors.ts";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { useNavigation } from "../shell/navigation.tsx";
import { Page } from "../shell/Page.tsx";
import { useProviderPanesEnabled } from "../surfaces/code/panes/useProviderPanes.ts";
import { Examples, LimitNotice, RequestForm, ResultView } from "./Assistant.tsx";
import { limitReached, remainingRequests, usedLine } from "./assistantState.ts";
import styles from "./KalVoicePage.module.css";
import { type HistoryItem, useKalVoice } from "./KalVoiceProvider.tsx";
import { LatencyDiagnostics } from "./LatencyDiagnostics.tsx";
import { localIntelligence } from "./localIntelligence.ts";
import { pushToTalkReadiness } from "./readiness.ts";
import { displayKey } from "./shortcutModel.ts";
import { KalVoiceWordmark, Orb } from "./Visuals.tsx";

function Key({ name }: { name: string }) {
  return <kbd>{displayKey(name)}</kbd>;
}

/**
 * The Intelligence tile's call to action for each state: a failed local startup retries right
 * here; setup and resuming live in settings.
 */
function intelligenceAction(status: KalVoiceStatus): { label: string; retry: boolean } | null {
  const view = localIntelligence(status);
  if (status.localReasoning === "not_installed") {
    // Preparing on its own needs nothing from the owner; a pause is resumed in Settings.
    if (view.resumable) return { label: "Open KalVoice settings", retry: false };
    return view.pausable ? null : { label: "Set up local intelligence", retry: false };
  }
  return view.retry ? { label: "Retry", retry: true } : null;
}

function historyKind(item: HistoryItem): string {
  if (item.response) return item.response.outcome.kind;
  if (!item.localResult) return "pending";
  if (item.localResult.ok) return "completed";
  return item.localResult.message === "Cancelled." ? "cancelled" : "failed";
}

function historyOutcome(item: HistoryItem): string {
  if (item.localResult) return item.localResult.message;
  if (!item.response) return "Working…";
  const { outcome } = item.response;
  if (outcome.kind === "completed") return outcome.summary;
  if (outcome.kind === "failed" || outcome.kind === "needs_provider") return outcome.message;
  if (outcome.kind === "limit_reached") return "Monthly limit reached.";
  return "The provider session is waiting for permission in its native prompt.";
}

/** The KalVoice surface: ask, see what's ready, and this session's requests. */
export function KalVoicePage() {
  const kv = useKalVoice();
  const {
    status,
    statusError,
    signalsError,
    talkKey,
    retryConnection,
    state,
    levelRef,
    history,
    submit,
    setPanelVisible,
    retryReasoning,
  } = kv;
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // The same local startup retry as KalVoice settings, without leaving the page.
  const retryIntelligence = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await retryReasoning();
    } catch (error) {
      setRetryError(toKalCodeError(error).message);
    } finally {
      setRetrying(false);
    }
  };
  const { navigate } = useNavigation();
  const { info } = useRuntime();
  const providerPanes = useProviderPanesEnabled();

  // "Ready" only when the native talk key is registered; otherwise the exact reason.
  const readiness = pushToTalkReadiness(status, statusError, signalsError, talkKey);
  const dictation = !status
    ? null
    : readiness.ready
      ? {
          tone: "success" as const,
          label: "Ready",
          detail: `${status.models.find((m) => m.id === status.activeModel)?.displayName ?? status.activeModel} model, on this computer.`,
          fix: null,
          action: "settings" as const,
        }
      : {
          tone:
            readiness.code === "speech_engine_unavailable" || readiness.code === "microphone_unsupported"
              ? ("outline" as const)
              : ("waiting" as const),
          label: readiness.label,
          detail: readiness.message,
          fix:
            readiness.code === "model_not_installed"
              ? "Set up speech"
              : readiness.fix === "settings"
                ? "Open KalVoice settings"
                : readiness.fix === "retry"
                  ? "Try again"
                  : null,
          action: readiness.fix === "retry" ? ("retry" as const) : ("settings" as const),
        };

  const intelligence = status ? { ...localIntelligence(status), action: intelligenceAction(status) } : null;

  return (
    <Page
      title="KalVoice"
      description="Dictate into any KalCode text box and run KalCode by voice or text."
      actions={
        status && !status.preferences.panelVisible ? (
          <Button variant="primary" icon={<AudioLines />} onClick={() => setPanelVisible(true)}>
            Show the widget
          </Button>
        ) : null
      }
    >
      <figure className={styles.hero}>
        {/* Lit edges on inert elements, not pseudo-elements (see KalVoicePage.module.css). */}
        <span className={styles.heroEdge} aria-hidden="true" />
        <Orb phase={state.phase} levelRef={levelRef} size={120} />
        <figcaption className={styles.heroText}>
          <KalVoiceWordmark className={styles.heroWordmark} />
          <span className={styles.heroLine}>
            Speak your prompts. Control your workspace. Coordinate your coding agents.
          </span>
        </figcaption>
      </figure>

      <Section
        id="kalvoice-ask"
        title="Type a request"
        description="For when you'd rather not speak. The same commands and answers as push to talk."
      >
        <div className={styles.ask}>
          <RequestForm id="kalvoice-page-request" />
          <ResultView />
          <Examples onPick={(text) => void submit(text, "text")} providerPanes={providerPanes} />
          {/* Usage lives in the This month card; here only the limit, when it matters. */}
          <LimitNotice />
        </div>
      </Section>

      <Section id="kalvoice-status" title="Status">
        {status ? (
          <ul className={styles.tiles}>
            <li className={styles.tile}>
              <span className={styles.tileEdge} aria-hidden="true" />
              <p className={styles.tileTitle}>Push to talk</p>
              {dictation ? <Badge tone={dictation.tone}>{dictation.label}</Badge> : null}
              <p className={styles.tileDetail}>{dictation?.detail}</p>
              <p className={styles.tileMeta}>
                Hold <Key name={status.preferences.talkKey} /> to talk to KalVoice
              </p>
              {dictation?.fix ? (
                <Button
                  size="sm"
                  onClick={() => (dictation.action === "retry" ? void retryConnection() : navigate("settings"))}
                >
                  {dictation.fix}
                </Button>
              ) : null}
            </li>
            <li className={styles.tile}>
              <span className={styles.tileEdge} aria-hidden="true" />
              <p className={styles.tileTitle}>Commands</p>
              <Badge tone="success">Available</Badge>
              <p className={styles.tileDetail}>
                {providerPanes
                  ? "Say “Open Activity” or “Open four Codex terminals”: KalCode acts the moment you let go. Provider sessions keep their own native permission prompts."
                  : "Say “Open Activity” or “Go to settings”: KalCode acts the moment you let go."}
              </p>
              <p className={styles.tileMeta}>Dictation is never counted</p>
            </li>
            <li className={styles.tile}>
              <span className={styles.tileEdge} aria-hidden="true" />
              <p className={styles.tileTitle}>Intelligence</p>
              {intelligence ? <Badge tone={intelligence.tone}>{intelligence.label}</Badge> : null}
              <p className={styles.tileDetail}>{retryError ?? intelligence?.detail}</p>
              {intelligence?.action?.retry ? (
                <Button size="sm" icon={<RefreshCw />} busy={retrying} onClick={() => void retryIntelligence()}>
                  {intelligence.action.label}
                </Button>
              ) : intelligence?.action ? (
                <Button size="sm" onClick={() => navigate("settings")}>
                  {intelligence.action.label}
                </Button>
              ) : null}
            </li>
            <li className={styles.tile}>
              <span className={styles.tileEdge} aria-hidden="true" />
              <p className={styles.tileTitle}>This month</p>
              {limitReached(status.usage) ? <Badge tone="waiting">Limit reached</Badge> : null}
              <p className={styles.tileFigure}>
                {remainingRequests(status.usage)?.toLocaleString("en-US") ?? "Unlimited"}
                <span>{status.usage.allowance === null ? " requests" : " remaining"}</span>
              </p>
              {status.usage.allowance !== null ? (
                <div className={styles.meter} aria-hidden="true">
                  <span
                    style={{
                      transform: `scaleX(${Math.min(1, status.usage.used / Math.max(1, status.usage.allowance))})`,
                    }}
                  />
                </div>
              ) : null}
              <p className={styles.tileMeta}>{usedLine(status.usage)}</p>
              <p className={styles.tileMeta}>Local Dictation: Unlimited</p>
              <p className={styles.tileMeta}>Provider usage: Handled by your connected provider</p>
            </li>
          </ul>
        ) : statusError || signalsError ? (
          <div role="alert">
            <p className={styles.tileDetail}>{readiness.message}</p>
            <Button size="sm" onClick={() => void retryConnection()}>
              Try again
            </Button>
          </div>
        ) : null}
      </Section>

      <Section
        id="kalvoice-history"
        title="This session"
        description="Kept in this window only. Requests are never saved or sent in activity events."
      >
        {history.length === 0 ? (
          <EmptyState art={<MessageSquareText />} title="No requests yet">
            <p>
              Type something above, or hold {status ? displayKey(status.preferences.talkKey) : "the push-to-talk key"}{" "}
              and speak.
            </p>
          </EmptyState>
        ) : (
          <ol className={styles.history}>
            {history.map((item) => (
              <li key={item.requestId} className={styles.historyItem}>
                <p className={styles.historyText}>
                  {item.input === "voice" ? <AudioLines aria-label="Spoken" /> : <Sparkles aria-label="Typed" />}
                  {item.text}
                </p>
                <p className={styles.historyOutcome} data-kind={historyKind(item)}>
                  {historyOutcome(item)}
                  {item.response?.counted ? <span className={styles.counted}> · counted</span> : null}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {info.channel === "development" ? <LatencyDiagnostics /> : null}

      <Section id="kalvoice-privacy" title="Privacy">
        <ul className={styles.privacy}>
          <li>
            <span className={styles.privacyMark} aria-hidden="true" />
            Audio is held in memory on this computer, recognized here, and discarded right after.
          </li>
          <li>
            <span className={styles.privacyMark} aria-hidden="true" />
            Nothing you say is recorded, stored or uploaded. Activity shows ids and counts, never your words.
          </li>
          <li>
            <span className={styles.privacyMark} aria-hidden="true" />
            Command interpretation runs on this computer. Coding tasks you send to a provider use that provider's
            account and permissions.
          </li>
        </ul>
      </Section>
    </Page>
  );
}
