import { IconButton } from "@kalcode/ui/components";
import { ArrowRightLeft, X } from "lucide-react";
import { useEffect, useState } from "react";
import { accountName } from "../../providers/accountIdentity.ts";
import { suggestAccounts } from "../../providers/accountSuggestions.ts";
import { useOptionalProviderAccountSessions } from "../../providers/ProviderAccountSessions.tsx";
import styles from "./PaneAccountPicker.module.css";
import { PaneAccountPicker, type PaneAccountPickerProps } from "./PaneAccountPicker.tsx";

/** Inline advice never steals focus, launches an agent, or changes an account preference. */
export function PaneAccountSuggestion(props: PaneAccountPickerProps) {
  const sessions = useOptionalProviderAccountSessions();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (!sessions?.accounts || sessions.loadError) return null;
  const suggestion = suggestAccounts(
    props.thread,
    sessions.accounts,
    sessions.usage,
    sessions.checking,
    sessions.validationErrors,
    Date.now(),
  );
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
