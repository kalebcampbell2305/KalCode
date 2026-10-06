import { CORE_LIMITS, formatCoreLimit, getPlan, UNLIMITED_NOTE } from "@kalcode/protocol";
import { Button, SegmentedControl, TextInput } from "@kalcode/ui/components";
import { Check, Circle, Mail, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  type AccountSnapshot,
  type BillingInterval,
  PLAN_CATALOG,
  type PlanCatalogEntry,
  type PurchasableTier,
  SESSION_EXPIRED_REASON,
} from "../ipc/account.ts";
import { Mark } from "../shell/Brand.tsx";
import styles from "./Account.module.css";
import type { SocialProvider } from "./AccountProvider.tsx";
import type { AccountUiError } from "./accountState.ts";
import { SocialAuthButtons } from "./SocialAuthButtons.tsx";

export interface AccountOnboardingActions {
  startEmail(email: string): Promise<void>;
  startSocial(provider: SocialProvider): Promise<void>;
  pollEmail(): Promise<void>;
  /** Also leaves an unfinished checkout and goes back to plan choice. */
  cancelAuth(): Promise<void>;
  activateFree(): Promise<void>;
  checkout(tier: PurchasableTier, interval: BillingInterval): Promise<void>;
  retry(): Promise<void>;
  logout(): Promise<void>;
}

export interface AccountOnboardingProps {
  snapshot: AccountSnapshot;
  busy: boolean;
  error: AccountUiError | null;
  actions: AccountOnboardingActions;
}

type EntryMode = "sign_in" | null;
const FLOW = ["Sign in", "Verify", "Plan", "Ready"] as const;
const BILLING_OPTIONS = [
  { value: "month", label: "Monthly" },
  { value: "year", label: "Yearly" },
] as const satisfies readonly { value: BillingInterval; label: string }[];

function usd(value: number): string {
  return `$${value.toLocaleString("en-US")}`;
}

/** The price a plan card shows for the chosen interval; Free never changes. */
function planPrice(plan: PlanCatalogEntry, interval: BillingInterval): { amount: string; detail: string } {
  if (plan.monthlyPriceUsd === 0) return { amount: usd(0), detail: "No checkout" };
  if (interval === "year") {
    return { amount: usd(plan.yearlyPriceUsd), detail: `per year · save ${usd(plan.yearlySavingsUsd)}` };
  }
  return { amount: usd(plan.monthlyPriceUsd), detail: "per month" };
}

function activeStep(phase: AccountSnapshot["phase"]): number {
  switch (phase) {
    case "bootstrapping":
    case "signed_out":
    case "degraded":
      return 0;
    case "email_pending":
    case "social_pending":
      return 1;
    case "authenticated_unactivated":
    case "confirming_plan":
      return 2;
    case "ready":
    case "offline_grace":
      return 3;
  }
}

function AccountCircuit({ phase }: { phase: AccountSnapshot["phase"] }) {
  const current = activeStep(phase);
  return (
    <ol className={styles.circuit} aria-label="Account setup progress">
      {FLOW.map((label, index) => (
        <li key={label} data-state={index < current ? "done" : index === current ? "current" : "next"}>
          <span className={styles.circuitNode} aria-hidden="true">
            {index < current ? <Check /> : <Circle />}
          </span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

export function AccountOnboarding({ snapshot, busy, error, actions }: AccountOnboardingProps) {
  const [mode, setMode] = useState<EntryMode>(null);
  const [email, setEmail] = useState("");
  const [billing, setBilling] = useState<BillingInterval>("month");
  const emailId = useId();
  // Coming back from the email app checks the link without another click; the button stays.
  const pollWhenBack = useRef({ busy, pollEmail: actions.pollEmail });
  pollWhenBack.current = { busy, pollEmail: actions.pollEmail };
  const emailPending = snapshot.phase === "email_pending";
  // The email form closes once the link is sent; a failed request keeps it (and the address).
  const signedOut = snapshot.phase === "signed_out";
  useEffect(() => {
    if (!signedOut) setMode(null);
  }, [signedOut]);
  useEffect(() => {
    if (!emailPending) return;
    const onFocus = () => {
      if (!pollWhenBack.current.busy) void pollWhenBack.current.pollEmail();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [emailPending]);
  const submitEmail = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (!normalized || busy) return;
    await actions.startEmail(normalized);
  };

  return (
    <main className={styles.screen} aria-labelledby="account-title">
      <section className={styles.card}>
        <header className={styles.header}>
          <Mark size={44} className={styles.mark} />
          <AccountCircuit phase={snapshot.phase} />
        </header>

        {snapshot.phase === "bootstrapping" ? (
          <div className={styles.center} role="status" aria-busy={!error}>
            <p className={styles.eyebrow}>Account</p>
            <h1 id="account-title">Restoring your session</h1>
            <p>KalCode is verifying this device before opening your workspace.</p>
            {error?.retryable ? (
              <Button variant="primary" busy={busy} onClick={() => void actions.retry()}>
                Try again
              </Button>
            ) : null}
          </div>
        ) : snapshot.phase === "signed_out" && mode === null && snapshot.degradedReason === SESSION_EXPIRED_REASON ? (
          // A returning person whose session ran out: say so instead of the first-run welcome.
          <div className={styles.center}>
            <p className={styles.eyebrow}>Session expired</p>
            <h1 id="account-title">Your session expired — sign in again</h1>
            <p role="status">For your security, KalCode ended this session. Sign in again to keep working.</p>
            <SocialAuthButtons busy={busy} startSocial={actions.startSocial} />
            <div className={styles.actions}>
              <Button variant="primary" size="lg" disabled={busy} onClick={() => setMode("sign_in")}>
                Continue with email
              </Button>
            </div>
          </div>
        ) : snapshot.phase === "signed_out" && mode === null ? (
          <div className={styles.center}>
            <p className={styles.eyebrow}>Private by design</p>
            <h1 id="account-title">Welcome to KalCode</h1>
            <p>Sign in securely. Your session stays in this device's credential store.</p>
            <SocialAuthButtons busy={busy} startSocial={actions.startSocial} />
            <div className={styles.actions}>
              {/* One email entry: the same one-time link signs in or creates the account. */}
              <Button variant="primary" size="lg" disabled={busy} onClick={() => setMode("sign_in")}>
                Continue with email
              </Button>
            </div>
          </div>
        ) : snapshot.phase === "signed_out" ? (
          <form className={styles.form} onSubmit={submitEmail}>
            <p className={styles.eyebrow}>Sign in</p>
            <h1 id="account-title">Continue with email</h1>
            <p>KalCode sends the same private, one-time link whether this email is new or returning.</p>
            <label htmlFor={emailId}>Email</label>
            <TextInput
              id={emailId}
              type="email"
              value={email}
              autoComplete="email"
              required
              autoFocus
              onChange={(event) => setEmail(event.target.value)}
            />
            <div className={styles.actions}>
              <Button type="submit" variant="primary" busy={busy} icon={<Mail />}>
                Email me a sign-in link
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setMode(null)}>
                Back
              </Button>
            </div>
          </form>
        ) : snapshot.phase === "email_pending" ? (
          <div className={styles.center}>
            <p className={styles.eyebrow}>Verification</p>
            <h1 id="account-title">Check your email</h1>
            <p>
              Open the one-time link sent to <strong data-selectable>{snapshot.pendingEmail}</strong>, then return here.
            </p>
            <div className={styles.actions}>
              <Button variant="primary" busy={busy} onClick={() => void actions.pollEmail()}>
                I've verified my email
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void actions.cancelAuth()}>
                Cancel
              </Button>
            </div>
          </div>
        ) : snapshot.phase === "social_pending" ? (
          <div className={styles.center} role="status" aria-busy="true">
            <ShieldCheck className={styles.heroIcon} aria-hidden="true" />
            <p className={styles.eyebrow}>Secure sign in</p>
            <h1 id="account-title">Finish in your browser</h1>
            <p>Complete the Google or Microsoft sign-in in your system browser, then return to KalCode.</p>
            <Button variant="ghost" disabled={busy} onClick={() => void actions.cancelAuth()}>
              Cancel
            </Button>
          </div>
        ) : snapshot.phase === "authenticated_unactivated" ? (
          <div>
            <div className={styles.planHeading}>
              <p className={styles.eyebrow}>Account verified</p>
              <h1 id="account-title">Choose your plan</h1>
              <p>Unlimited local coding agents, terminals and on-device dictation on every plan.</p>
              <SegmentedControl<BillingInterval>
                aria-label="Billing interval"
                className={styles.billing}
                value={billing}
                onValueChange={setBilling}
                disabled={busy}
                options={BILLING_OPTIONS}
              />
            </div>
            <div className={styles.plans}>
              {PLAN_CATALOG.map((plan) => {
                const price = planPrice(plan, billing);
                return (
                  <article className={styles.plan} key={plan.tier} data-featured={plan.popular || undefined}>
                    <div>
                      {plan.popular ? <p className={styles.popular}>Most popular</p> : null}
                      <p className={styles.stage}>{plan.stage}</p>
                      <h2>{plan.name}</h2>
                      <p className={styles.price}>{price.amount}</p>
                      <p>{price.detail}</p>
                      <p className={styles.tagline}>{plan.tagline}</p>
                    </div>
                    <ul className={styles.planLimits}>
                      {CORE_LIMITS.map((limit) => (
                        <li key={limit.key}>{formatCoreLimit(getPlan(plan.tier).limits, limit)}</li>
                      ))}
                    </ul>
                    <Button
                      variant={plan.popular ? "primary" : "secondary"}
                      busy={busy}
                      onClick={() =>
                        void (plan.tier === "free" ? actions.activateFree() : actions.checkout(plan.tier, billing))
                      }
                    >
                      {plan.tier === "free" ? "Continue with Free" : `Choose ${plan.name}`}
                    </Button>
                  </article>
                );
              })}
            </div>
            <p className={styles.planNote}>{UNLIMITED_NOTE}</p>
            <div className={styles.actions}>
              <Button variant="ghost" disabled={busy} onClick={() => void actions.logout()}>
                Sign out
              </Button>
            </div>
          </div>
        ) : snapshot.phase === "confirming_plan" ? (
          <div className={styles.center} role="status" aria-busy={busy || undefined}>
            <ShieldCheck className={styles.heroIcon} aria-hidden="true" />
            <p className={styles.eyebrow}>Checkout</p>
            <h1 id="account-title">Confirming plan</h1>
            <p>Finish paying in your browser, then come back. KalCode unlocks your plan once the server confirms it.</p>
            <div className={styles.actions}>
              {error?.retryable ? (
                <Button variant="primary" busy={busy} onClick={() => void actions.retry()}>
                  Check again
                </Button>
              ) : null}
              {/* Closed the checkout without paying: pick Free or another plan instead. */}
              <Button variant="ghost" disabled={busy} onClick={() => void actions.cancelAuth()}>
                Choose a different plan
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void actions.logout()}>
                Sign out
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.center}>
            <p className={styles.eyebrow}>Account unavailable</p>
            <h1 id="account-title">Reconnect to continue</h1>
            <p>KalCode could not verify account authority. Your workspace remains locked.</p>
            <Button variant="primary" busy={busy} onClick={() => void actions.retry()}>
              Try again
            </Button>
          </div>
        )}

        {error ? (
          <p className={styles.error} role="alert">
            {error.message}
          </p>
        ) : null}
      </section>
    </main>
  );
}
