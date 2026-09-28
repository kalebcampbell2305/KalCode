import { Badge, Button, EmptyState, Section } from "@kalcode/ui/components";
import { AudioLines, MessageSquareText, Sparkles } from "lucide-react";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { useNavigation } from "../shell/navigation.tsx";
import { Page } from "../shell/Page.tsx";
import { Examples, RequestForm, ResultView, UsageFooter } from "./Assistant.tsx";
import { usageLine } from "./assistantState.ts";
import styles from "./KalVoicePage.module.css";
import { useKalVoice } from "./KalVoiceProvider.tsx";
import { LatencyDiagnostics } from "./LatencyDiagnostics.tsx";
import { displayKey } from "./shortcutModel.ts";
import { KalVoiceWordmark, Orb } from "./Visuals.tsx";

function Key({ name }: { name: string }) {
  return <kbd>{displayKey(name)}</kbd>;
}

const LOCAL_INTELLIGENCE = {
  not_installed: {
    tone: "waiting",
    label: "Not installed",
    detail: "Direct commands work now. Download the on-device interpreter for other supported phrasing.",
    action: "Set up local intelligence",
  },
  installed: {
    tone: "waiting",
    label: "Installed; not running",
    detail: "The local interpreter is installed. Retry startup in KalVoice settings.",
    action: "Open KalVoice settings",
  },
  warming: {
    tone: "waiting",
    label: "Starting",
    detail: "The on-device interpreter is starting. Direct commands remain available.",
    action: null,
  },
  ready: {
    tone: "success",
    label: "Ready",
    detail: "The on-device interpreter handles supported phrasing without a connected provider.",
    action: null,
  },
  unavailable: {
    tone: "outline",
    label: "Unavailable",
    detail: "Direct commands remain available. Check local interpreter startup in KalVoice settings.",
    action: "Open KalVoice settings",
  },
} as const;

/** The KalVoice surface: ask, see what's ready, and this session's requests. */
export function KalVoicePage() {
  const kv = useKalVoice();
  const { status, state, levelRef, history, submit, setPanelVisible } = kv;
  const { navigate } = useNavigation();
  const { info } = useRuntime();

  const dictation = !status
    ? null
    : !status.speechEngine
      ? {
          tone: "outline" as const,
          label: "Not in this build",
          detail: "This build doesn't include the on-device speech engine.",
        }
      : !status.microphoneSupported
        ? {
            tone: "outline" as const,
            label: "Unavailable",
            detail: "Microphone capture isn't supported on this platform yet.",
          }
        : !status.activeModel
          ? {
              tone: "waiting" as const,
              label: "Needs a speech model",
              detail: "Download a speech model to start dictating.",
            }
          : {
              tone: "success" as const,
              label: "Ready",
              detail: `${status.models.find((m) => m.id === status.activeModel)?.displayName ?? status.activeModel} model, on this computer.`,
            };

  const intelligence = status ? LOCAL_INTELLIGENCE[status.localReasoning ?? "unavailable"] : null;

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
          <Examples onPick={(text) => void submit(text, "text")} />
          <UsageFooter />
        </div>
      </Section>

      <Section id="kalvoice-status" title="Status">
        {status ? (
          <ul className={styles.tiles}>
            <li className={styles.tile}>
              <p className={styles.tileTitle}>Push to talk</p>
              {dictation ? <Badge tone={dictation.tone}>{dictation.label}</Badge> : null}
              <p className={styles.tileDetail}>{dictation?.detail}</p>
              <p className={styles.tileMeta}>
                Hold <Key name={status.preferences.talkKey} /> to talk to KalVoice
              </p>
              {dictation?.tone === "waiting" ? (
                <Button size="sm" onClick={() => navigate("settings")}>
                  Set up speech
                </Button>
              ) : null}
            </li>
            <li className={styles.tile}>
              <p className={styles.tileTitle}>Commands</p>
              <Badge tone="success">Ready</Badge>
              <p className={styles.tileDetail}>
                Say “Open Dashboard” or “Open four Codex terminals”: KalCode acts the moment you let go. Provider
                sessions keep their own native permission prompts.
              </p>
              <p className={styles.tileMeta}>Dictation is never counted</p>
            </li>
            <li className={styles.tile}>
              <p className={styles.tileTitle}>Intelligence</p>
              {intelligence ? <Badge tone={intelligence.tone}>{intelligence.label}</Badge> : null}
              <p className={styles.tileDetail}>{intelligence?.detail}</p>
              {intelligence?.action ? (
                <Button size="sm" onClick={() => navigate("settings")}>
                  {intelligence.action}
                </Button>
              ) : null}
            </li>
            <li className={styles.tile}>
              <p className={styles.tileTitle}>This month</p>
              <p className={styles.tileFigure}>
                {status.usage.used.toLocaleString("en-US")}
                <span>
                  {status.usage.allowance === null
                    ? " requests"
                    : ` of ${status.usage.allowance.toLocaleString("en-US")}`}
                </span>
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
              <p className={styles.tileMeta}>{usageLine(status.usage)}</p>
              <p className={styles.tileMeta}>Local Dictation: Unlimited</p>
              <p className={styles.tileMeta}>Provider usage: Handled by your connected provider</p>
            </li>
          </ul>
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
                <p className={styles.historyOutcome} data-kind={item.response?.outcome.kind ?? "pending"}>
                  {item.response === null
                    ? "Working…"
                    : item.response.outcome.kind === "completed"
                      ? item.response.outcome.summary
                      : item.response.outcome.kind === "failed" || item.response.outcome.kind === "needs_provider"
                        ? item.response.outcome.message
                        : item.response.outcome.kind === "limit_reached"
                          ? "Monthly limit reached."
                          : "The provider session is waiting for permission in its native prompt."}
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
          <li>Audio is held in memory on this computer, recognized here, and discarded right after.</li>
          <li>Nothing you say is recorded, stored or uploaded. Activity shows ids and counts, never your words.</li>
          <li>
            Command interpretation runs on this computer. Coding tasks you send to a provider use that provider's
            account and permissions.
          </li>
        </ul>
      </Section>
    </Page>
  );
}
