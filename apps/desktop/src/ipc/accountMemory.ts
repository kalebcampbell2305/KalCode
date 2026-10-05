/**
 * Deterministic account adapter for the explicit UI-test memory transport.
 * It has no credentials, browser launches, email, payment, or network effects.
 */
import { limitsFor } from "@kalcode/protocol";
import { accountDisplayNameProblem } from "../account/displayName.ts";
import {
  type AccountCommandName,
  type AccountOpenResult,
  type AccountSnapshot,
  type AccountTier,
  type AccountUsageSnapshot,
  type PurchasableTier,
  type RuntimeStatus,
  SESSION_EXPIRED_REASON,
} from "./account.ts";

export type AccountMemoryScenario =
  | "fresh"
  | "unactivated"
  | "ready"
  | "ready_pro"
  | "ready_max"
  | "expired"
  | "offline_grace";
type HandlerResult = AccountSnapshot | AccountOpenResult | AccountUsageSnapshot | RuntimeStatus | null;
type AccountMemoryHandler = (args?: Record<string, unknown>) => Promise<HandlerResult>;

const ACCOUNT_ID = "account_test_owner";
const ACCOUNT_EMAIL = "owner@example.com";
const SESSION_EXPIRY = "2030-01-02T00:00:00.000Z";
const PENDING_EXPIRY = "2030-01-01T00:15:00.000Z";
const ACTIVATED_AT = "2030-01-01T00:01:00.000Z";
const ENTITLEMENT_EXPIRY = 1_893_542_400;
const OFFLINE_GRACE_UNTIL = 1_893_549_600;

function signedOut(): AccountSnapshot {
  return {
    phase: "signed_out",
    account: null,
    tier: null,
    sessionExpiresAt: null,
    entitlementExpiresAt: null,
    offlineGraceUntil: null,
    pendingEmail: null,
    pendingExpiresAt: null,
    degradedReason: null,
  };
}

function pending(email: string): AccountSnapshot {
  return { ...signedOut(), phase: "email_pending", pendingEmail: email, pendingExpiresAt: PENDING_EXPIRY };
}

function unactivated(email = ACCOUNT_EMAIL, displayName: string | null = null): AccountSnapshot {
  return {
    ...signedOut(),
    phase: "authenticated_unactivated",
    account: { id: ACCOUNT_ID, email, activatedAt: null, displayName },
    sessionExpiresAt: SESSION_EXPIRY,
  };
}

function confirming(email = ACCOUNT_EMAIL): AccountSnapshot {
  return { ...unactivated(email), phase: "confirming_plan" };
}

function ready(tier: AccountTier = "free", email = ACCOUNT_EMAIL, displayName: string | null = null): AccountSnapshot {
  return {
    ...signedOut(),
    phase: "ready",
    account: { id: ACCOUNT_ID, email, activatedAt: ACTIVATED_AT, displayName },
    tier,
    billingInterval: tier === "free" || tier === "owner" ? null : "month",
    sessionExpiresAt: SESSION_EXPIRY,
    entitlementExpiresAt: ENTITLEMENT_EXPIRY,
  };
}

function offlineGrace(): AccountSnapshot {
  return {
    ...ready("free"),
    phase: "offline_grace",
    offlineGraceUntil: OFFLINE_GRACE_UNTIL,
    degradedReason: "Account verification is temporarily offline.",
  };
}

function initialSnapshot(scenario: AccountMemoryScenario): AccountSnapshot {
  switch (scenario) {
    case "fresh":
      return signedOut();
    case "expired":
      // Mirrors native `AccountSnapshot::session_expired` (a stored session ran out or got a 401).
      return { ...signedOut(), degradedReason: SESSION_EXPIRED_REASON };
    case "unactivated":
      return unactivated();
    case "ready":
      return ready();
    case "ready_pro":
      return ready("pro");
    case "ready_max":
      return ready("max");
    case "offline_grace":
      return offlineGrace();
  }
}

function requiredEmail(args: Record<string, unknown> | undefined): string {
  const email = args?.email;
  if (typeof email !== "string" || email.length > 320 || !email.includes("@")) {
    throw new Error("Enter a valid email address.");
  }
  return email;
}

/** Mirrors the API's rule: trimmed; empty clears; 1–64 characters, no control/invisible ones. */
function requestedDisplayName(args: Record<string, unknown> | undefined): string | null {
  const value = args?.displayName;
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Invalid display name.");
  const trimmed = value.normalize("NFC").trim();
  if (trimmed.length === 0) return null;
  if (accountDisplayNameProblem(trimmed)) {
    throw {
      code: "invalid_display_name",
      message: "Use 1–64 characters, without control or invisible formatting characters.",
      retryable: false,
    };
  }
  return trimmed;
}

function requiredTier(args: Record<string, unknown> | undefined): PurchasableTier {
  const tier = args?.tier;
  if (tier !== "pro" && tier !== "max" && tier !== "max2x") throw new Error("Choose a paid KalCode plan.");
  return tier;
}

export function createAccountMemory(scenario: AccountMemoryScenario) {
  let snapshot = initialSnapshot(scenario);
  let confirmingInterval: "month" | "year" = "month";
  let pendingEmail: string | null = null;
  let confirmingTier: PurchasableTier | null = null;
  const effects = { emails: 0, checkouts: 0, browserOpens: 0 };

  const runtimeStatus = (): RuntimeStatus => ({
    phase: snapshot.phase === "ready" || snapshot.phase === "offline_grace" ? "ready" : "signed_out",
    ready: snapshot.phase === "ready" || snapshot.phase === "offline_grace",
  });

  const handlers: Record<AccountCommandName, AccountMemoryHandler> = {
    async account_status() {
      return snapshot;
    },
    async runtime_status() {
      return runtimeStatus();
    },
    async runtime_retry() {
      return null;
    },
    async account_email_start(args) {
      pendingEmail = requiredEmail(args);
      snapshot = pending(pendingEmail);
      return snapshot;
    },
    async account_social_start(args) {
      if (args?.provider !== "google" && args?.provider !== "microsoft") throw new Error("Invalid social provider.");
      pendingEmail = null;
      snapshot = { ...signedOut(), phase: "social_pending", pendingExpiresAt: "2030-01-01T00:10:00.000Z" };
      return snapshot;
    },
    async account_email_poll() {
      if (snapshot.phase === "email_pending" && pendingEmail !== null) {
        snapshot = unactivated(pendingEmail);
        pendingEmail = null;
      }
      return snapshot;
    },
    async account_auth_cancel() {
      pendingEmail = null;
      snapshot = signedOut();
      return snapshot;
    },
    async account_activate_free() {
      if (snapshot.phase === "authenticated_unactivated") snapshot = ready("free", snapshot.account?.email);
      return snapshot;
    },
    async account_checkout(args) {
      if (snapshot.phase === "authenticated_unactivated") {
        confirmingTier = requiredTier(args);
        confirmingInterval = args?.interval === "year" ? "year" : "month";
        snapshot = confirming(snapshot.account?.email);
      }
      return snapshot;
    },
    async account_portal() {
      return { opened: true };
    },
    async account_refresh() {
      if (snapshot.phase === "confirming_plan" && confirmingTier !== null) {
        snapshot = { ...ready(confirmingTier, snapshot.account?.email), billingInterval: confirmingInterval };
        confirmingTier = null;
      }
      return snapshot;
    },
    async account_logout() {
      pendingEmail = null;
      confirmingTier = null;
      snapshot = signedOut();
      return snapshot;
    },
    async account_set_display_name(args) {
      const account = snapshot.account;
      if (!account || (snapshot.phase !== "ready" && snapshot.phase !== "offline_grace")) {
        throw { code: "authentication_required", message: "Sign in to continue.", retryable: false };
      }
      snapshot = { ...snapshot, account: { ...account, displayName: requestedDisplayName(args) } };
      return snapshot;
    },
    async account_usage() {
      return {
        used: 0,
        allowance: snapshot.tier === null ? 0 : limitsFor(snapshot.tier).kalvoiceRequestsPerMonth,
        periodStart: "2030-01-01T00:00:00.000Z",
        resetsAt: "2030-02-01T00:00:00.000Z",
      };
    },
  };

  return { handlers, effects };
}
