import { Button } from "@kalcode/ui/components";
import { useId } from "react";
import { useOptionalKalVoice } from "./KalVoiceProvider.tsx";
import styles from "./SessionChoicePanel.module.css";

/**
 * KalVoice's "Which one?" (`choose_session`): a non-modal list beside the widget. Clicking a
 * choice, or saying its name on the next push-to-talk, follows up (open it, or put the message in
 * its box). Nothing happens until the person answers; it goes away after 30 s or on Dismiss.
 */
export function SessionChoicePanel() {
  const kalvoice = useOptionalKalVoice();
  const id = useId();
  const sceneChoice = kalvoice?.sceneChoice;
  if (kalvoice && sceneChoice) {
    return (
      <section className={styles.panel} aria-labelledby={`${id}-scene-question`} data-kalvoice-choice>
        <p id={`${id}-scene-question`} className={styles.question} role="status">
          {sceneChoice.question}
        </p>
        <ul className={styles.choices} aria-label="Matches">
          {sceneChoice.choices.map((candidate, index) => (
            <li key={candidate.id}>
              <Button size="sm" className={styles.choice} onClick={() => kalvoice.chooseScene(candidate.id)}>
                {index + 1}. {candidate.label}
              </Button>
            </li>
          ))}
        </ul>
        <div className={styles.footer}>
          <p className={styles.hint}>Choose one, or say its name or number.</p>
          <Button size="sm" variant="ghost" onClick={kalvoice.dismissSceneChoice}>
            Dismiss
          </Button>
        </div>
      </section>
    );
  }
  const choice = kalvoice?.sessionChoice ?? null;
  if (!kalvoice || !choice) return null;
  return (
    <section className={styles.panel} aria-labelledby={`${id}-question`} data-kalvoice-choice>
      <p id={`${id}-question`} className={styles.question} role="status">
        {choice.question}
      </p>
      <ul className={styles.choices} aria-label="Sessions">
        {choice.choices.map((candidate) => (
          <li key={candidate.threadId}>
            <Button size="sm" className={styles.choice} onClick={() => kalvoice.chooseSession(candidate.threadId)}>
              {candidate.label}
            </Button>
          </li>
        ))}
      </ul>
      <div className={styles.footer}>
        <p className={styles.hint}>Click one, or hold the talk key and say its name.</p>
        <Button size="sm" variant="ghost" onClick={kalvoice.dismissSessionChoice}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
