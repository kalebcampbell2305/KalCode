import { IconButton } from "@kalcode/ui/components";
import { ArrowRightLeft, X } from "lucide-react";
import { useContext, useState } from "react";
import { useClock } from "../../dashboard/useNow.ts";
import { accountName } from "../../providers/accountIdentity.ts";
import { type AccountSuggestion, suggestAccounts } from "../../providers/accountSuggestions.ts";
import { useOptionalProviderAccountSessions } from "../../providers/ProviderAccountSessions.tsx";
import { CodeShownContext } from "../codeShown.ts";
import styles from "./PaneAccountPicker.module.css";
import { PaneAccountPicker, type PaneAccountPickerProps } from "./PaneAccountPicker.tsx";

/** Everything the advice shows, so a clock tick that changes none of it renders nothing. */
function adviceKey(suggestion: AccountSuggestion | null): string | null {
  if (!suggestion) return null;
  const best = suggestion.alternatives[0];
  return [suggestion.condition, suggestion.reason, best?.account.id ?? "", best?.detail ?? ""].join("|");
}

/** Inline advice never steals focus, launches an agent, or changes an account preference. */
export function PaneAccountSuggestion(props: PaneAccountPickerProps) {
  const sessions = useOptionalProviderAccountSessions();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const suggestAt = (now: number) =>
    sessions?.accounts && !sessions.loadError
      ? suggestAccounts(
          props.thread,
          sessions.accounts,
          sessions.usage,
          sessions.checking,
          sessions.validationErrors,
          now,
        )
      : null;
  // Usage windows age and reset, so the advice follows the shared clock, but a tick re-renders the
  // pane only when the advice reads differently, and never while Code is hidden. The advice itself
  // reads the current time: a usage read newer than the last tick must count at once.
  useClock((at) => adviceKey(suggestAt(at)), useContext(CodeShownContext));
  const suggestion = suggestAt(Date.now());
  if (!suggestion) return null;
  const conditionKey = `${props.thread.providerAccountId}:${suggestion.condition}`;
  if (dismissed === conditionKey) return null;
  const best = suggestion.alternatives[0];
  return (
    <aside className={styles.suggestion} aria-label="Account suggestion">
      <ArrowRightLeft aria-hidden="true" className={styles.suggestionIcon} />
      <div className={styles.suggestionCopy}>
        <p className={styles.suggestionReason}>{suggestion.reason}</p>
        <p className={styles.suggestionDetail}>
          {best
            ? `${accountName(best.account)} · ${best.detail}`
            : "No other signed-in account is ready for this provider."}
        </p>
        {best ? (
          <details className={styles.ranking}>
            <summary>Why this account?</summary>
            Same provider; known usage of at least 20% first, then your default, then name. Model access is checked when
            starting.
          </details>
        ) : null}
      </div>
      <PaneAccountPicker
        {...props}
        suggestion={{
          accountId: best?.account.id ?? null,
          label: best ? `Continue with ${accountName(best.account)}?` : "Review accounts",
        }}
      />
      <IconButton
        label="Dismiss account suggestion"
        icon={<X />}
        size="sm"
        onClick={() => setDismissed(conditionKey)}
      />
    </aside>
  );
}
