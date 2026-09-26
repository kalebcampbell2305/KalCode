import { Button } from "@kalcode/ui/components";
import type { ReactNode } from "react";
import type { AccountSnapshot, RuntimeStatus } from "../ipc/account.ts";
import styles from "./Account.module.css";
import { AccountOnboarding, type AccountOnboardingActions } from "./AccountOnboarding.tsx";
import { useAccount } from "./AccountProvider.tsx";
import type { AccountUiError } from "./accountState.ts";

export interface AccountGateProps {
  snapshot: AccountSnapshot;
  runtime: RuntimeStatus;
  busy: boolean;
  error: AccountUiError | null;
  actions: AccountOnboardingActions;
  children: ReactNode;
}

function RuntimeTransition({
  eyebrow,
  title,
  description,
  busy,
  error,
  onRetry,
}: {
  eyebrow: string;
  title: string;
  description: string;
  busy: boolean;
  error: AccountUiError | null;
  onRetry?: () => Promise<void>;
}) {
  return (
    <main className={styles.screen} aria-labelledby="account-runtime-title">
      <section className={styles.card}>
        <div className={styles.center} role="status" aria-busy={busy || undefined}>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1 id="account-runtime-title">{title}</h1>
          <p>{description}</p>
          {onRetry && error?.retryable ? (
            <Button variant="primary" busy={busy} onClick={() => void onRetry()}>
              Try again
            </Button>
          ) : null}
          {error ? (
            <p className={styles.error} role="alert">
              {error.message}
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}

export function AccountGate({ snapshot, runtime, busy, error, actions, children }: AccountGateProps) {
  const active = snapshot.phase === "ready" || snapshot.phase === "offline_grace";

  if (runtime.phase === "blocked_unclean") {
    return (
      <RuntimeTransition
        eyebrow="Cleanup incomplete"
        title="Workspace cleanup needs a restart"
        description="KalCode kept the workspace locked because a previous session did not close cleanly. Restart KalCode before signing in again."
        busy={false}
        error={error}
      />
    );
  }
  if (runtime.phase === "app_exiting") {
    return (
      <RuntimeTransition
        eyebrow="KalCode"
        title="Closing your workspace"
        description="KalCode is closing active sessions and local resources."
        busy
        error={error}
      />
    );
  }
  if (
    runtime.phase === "draining" ||
    (!active && snapshot.phase !== "bootstrapping" && runtime.phase !== "signed_out")
  ) {
    return (
      <RuntimeTransition
        eyebrow="Account signed out"
        title="Signing out securely"
        description="KalCode is closing active sessions before another account can sign in."
        busy={busy || !error}
        error={error}
        onRetry={actions.retry}
      />
    );
  }
  if (active && !runtime.ready) {
    return (
      <RuntimeTransition
        eyebrow="Account verified"
        title="Starting your workspace"
        description="KalCode is opening local services for this verified account."
        busy={busy || !error}
        error={error}
        onRetry={actions.retry}
      />
    );
  }
  if (!active) {
    return <AccountOnboarding snapshot={snapshot} busy={busy} error={error} actions={actions} />;
  }
  return (
    <>
      {snapshot.phase === "offline_grace" ? (
        <div className={styles.offline} role="status">
          Using verified offline access. Reconnect before the signed access period ends.
        </div>
      ) : null}
      {children}
    </>
  );
}

export function ConnectedAccountGate({ children }: { children: ReactNode }) {
  const { snapshot, runtime, busy, error, actions } = useAccount();
  return (
    <AccountGate snapshot={snapshot} runtime={runtime} busy={busy} error={error} actions={actions}>
      {children}
    </AccountGate>
  );
}
