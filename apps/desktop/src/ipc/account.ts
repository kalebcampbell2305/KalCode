export type AccountPhase =
  | "bootstrapping"
  | "signed_out"
  | "email_pending"
  | "social_pending"
  | "authenticated_unactivated"
  | "confirming_plan"
  | "ready"
  | "offline_grace"
  | "degraded";

export type RuntimePhase = "signed_out" | "starting" | "ready" | "draining" | "blocked_unclean" | "app_exiting";
export type AccountTier = "free" | "pro" | "max" | "max2x" | "owner";
export type PurchasableTier = Exclude<AccountTier, "free" | "owner">;

export interface PublicAccount {
  id: string;
  email: string;
  activatedAt: string | null;
}

export interface AccountSnapshot {
  phase: AccountPhase;
  account: PublicAccount | null;
  tier: AccountTier | null;
  sessionExpiresAt: string | null;
  entitlementExpiresAt: number | null;
  offlineGraceUntil: number | null;
  pendingEmail: string | null;
  pendingExpiresAt: string | null;
  degradedReason: string | null;
}

export interface RuntimeStatus {
  phase: RuntimePhase;
  ready: boolean;
  recovery?: { code: string; message: string; retryable: boolean } | null;
}

export interface AccountUsageSnapshot {
  used: number;
  allowance: number | null;
  periodStart: string;
  resetsAt: string;
}

export interface AccountOpenResult {
  opened: true;
}

export type AccountCommandName =
  | "account_status"
  | "account_email_start"
  | "account_social_start"
  | "account_email_poll"
  | "account_auth_cancel"
  | "account_activate_free"
  | "account_checkout"
  | "account_portal"
  | "account_refresh"
  | "account_logout"
  | "account_usage"
  | "runtime_status"
  | "runtime_retry";

export interface AccountTransport {
  invoke(command: AccountCommandName, args?: Record<string, unknown>): Promise<unknown>;
}

export const PLAN_CATALOG = [
  { tier: "free", name: "Free", requests: 75, monthlyPriceUsd: 0, action: "activate_free" },
  { tier: "pro", name: "Pro", requests: 1_500, monthlyPriceUsd: 10, action: "checkout" },
  { tier: "max", name: "Max", requests: 5_000, monthlyPriceUsd: 25, action: "checkout" },
  { tier: "max2x", name: "Max 2X", requests: 10_000, monthlyPriceUsd: 50, action: "checkout" },
] as const;

const PHASES = new Set<AccountPhase>([
  "bootstrapping",
  "signed_out",
  "email_pending",
  "social_pending",
  "authenticated_unactivated",
  "confirming_plan",
  "ready",
  "offline_grace",
  "degraded",
]);
const RUNTIME_PHASES = new Set<RuntimePhase>([
  "signed_out",
  "starting",
  "ready",
  "draining",
  "blocked_unclean",
  "app_exiting",
]);
const TIERS = new Set<AccountTier>(["free", "pro", "max", "max2x", "owner"]);
const SECRET_KEY_PARTS = [
  "token",
  "secret",
  "verifier",
  "receipt",
  "credential",
  "authorization",
  "cookie",
  "password",
];

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid native ${name}.`);
  }
  return value as Record<string, unknown>;
}

function rejectSecretFields(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretFields(item);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (SECRET_KEY_PARTS.some((part) => normalized.includes(part))) {
      throw new Error("Native account response contained a secret field.");
    }
    rejectSecretFields(nested);
  }
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid native ${name}.`);
  return value;
}

function nullableIso(value: unknown, name: string): string | null {
  const text = nullableString(value, name);
  if (text !== null && Number.isNaN(Date.parse(text))) throw new Error(`Invalid native ${name}.`);
  return text;
}

function nullableEpoch(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`Invalid native ${name}.`);
  return value as number;
}

function parsePublicAccount(value: unknown): PublicAccount | null {
  if (value === null) return null;
  const item = record(value, "account");
  const id = nullableString(item.id, "account id");
  const email = nullableString(item.email, "account email");
  if (id === null || email === null || !email.includes("@")) throw new Error("Invalid native account.");
  return { id, email, activatedAt: nullableIso(item.activatedAt, "activation time") };
}

export function parseAccountSnapshot(value: unknown): AccountSnapshot {
  rejectSecretFields(value);
  const item = record(value, "account snapshot");
  if (typeof item.phase !== "string" || !PHASES.has(item.phase as AccountPhase)) {
    throw new Error("Invalid native account phase.");
  }
  const phase = item.phase as AccountPhase;
  const account = parsePublicAccount(item.account);
  const tier =
    item.tier === null
      ? null
      : typeof item.tier === "string" && TIERS.has(item.tier as AccountTier)
        ? (item.tier as AccountTier)
        : undefined;
  if (tier === undefined) throw new Error("Invalid native account tier.");
  const snapshot: AccountSnapshot = {
    phase,
    account,
    tier,
    sessionExpiresAt: nullableIso(item.sessionExpiresAt, "session expiry"),
    entitlementExpiresAt: nullableEpoch(item.entitlementExpiresAt, "entitlement expiry"),
    offlineGraceUntil: nullableEpoch(item.offlineGraceUntil, "offline grace"),
    pendingEmail: nullableString(item.pendingEmail, "pending email"),
    pendingExpiresAt: nullableIso(item.pendingExpiresAt, "pending expiry"),
    degradedReason: nullableString(item.degradedReason, "degraded reason"),
  };

  if (
    ["bootstrapping", "signed_out", "email_pending", "social_pending", "degraded"].includes(phase) &&
    (account || tier)
  ) {
    throw new Error(`Invalid ${phase} account snapshot.`);
  }
  if (phase === "email_pending" && (!snapshot.pendingEmail || !snapshot.pendingExpiresAt)) {
    throw new Error("Invalid email_pending account snapshot.");
  }
  if (phase === "social_pending" && (snapshot.pendingEmail || !snapshot.pendingExpiresAt)) {
    throw new Error("Invalid social_pending account snapshot.");
  }
  if (phase !== "email_pending" && phase !== "social_pending" && (snapshot.pendingEmail || snapshot.pendingExpiresAt)) {
    throw new Error(`Invalid ${phase} account snapshot.`);
  }
  if (["authenticated_unactivated", "confirming_plan"].includes(phase) && (!account || tier !== null)) {
    throw new Error(`Invalid ${phase} account snapshot.`);
  }
  if (["ready", "offline_grace"].includes(phase) && (!account || !tier || snapshot.entitlementExpiresAt === null)) {
    throw new Error(`Invalid ${phase} account snapshot.`);
  }
  if (phase === "offline_grace" && snapshot.offlineGraceUntil === null) {
    throw new Error("Invalid offline_grace account snapshot.");
  }
  return snapshot;
}

export function parseRuntimeStatus(value: unknown): RuntimeStatus {
  rejectSecretFields(value);
  const item = record(value, "runtime status");
  if (typeof item.phase !== "string" || !RUNTIME_PHASES.has(item.phase as RuntimePhase)) {
    throw new Error("Invalid native runtime phase.");
  }
  if (typeof item.ready !== "boolean" || item.ready !== (item.phase === "ready")) {
    throw new Error("Invalid native runtime readiness.");
  }
  const status: RuntimeStatus = { phase: item.phase as RuntimePhase, ready: item.ready };
  if (item.recovery !== undefined && item.recovery !== null) {
    const recovery = record(item.recovery, "runtime recovery");
    if (
      item.phase !== "blocked_unclean" ||
      typeof recovery.code !== "string" ||
      typeof recovery.message !== "string" ||
      typeof recovery.retryable !== "boolean"
    ) {
      throw new Error("Invalid native runtime recovery.");
    }
    status.recovery = { code: recovery.code, message: recovery.message, retryable: recovery.retryable };
  }
  return status;
}

export function parseAccountUsage(value: unknown): AccountUsageSnapshot {
  rejectSecretFields(value);
  const item = record(value, "account usage");
  if (!Number.isSafeInteger(item.used) || (item.used as number) < 0) throw new Error("Invalid native usage count.");
  const allowance = item.allowance;
  if (allowance !== null && (!Number.isSafeInteger(allowance) || (allowance as number) < 0)) {
    throw new Error("Invalid native usage allowance.");
  }
  const periodStart = nullableIso(item.periodStart, "usage period start");
  const resetsAt = nullableIso(item.resetsAt, "usage reset time");
  if (!periodStart || !resetsAt) throw new Error("Invalid native usage period.");
  return { used: item.used as number, allowance: allowance as number | null, periodStart, resetsAt };
}

export class AccountClient {
  constructor(private readonly transport: AccountTransport) {}

  private async snapshot(command: AccountCommandName, args?: Record<string, unknown>): Promise<AccountSnapshot> {
    return parseAccountSnapshot(await this.transport.invoke(command, args));
  }

  status(): Promise<AccountSnapshot> {
    return this.snapshot("account_status");
  }

  async runtimeStatus(): Promise<RuntimeStatus> {
    return parseRuntimeStatus(await this.transport.invoke("runtime_status"));
  }

  async retryRuntime(): Promise<void> {
    await this.transport.invoke("runtime_retry");
  }

  startEmail(email: string): Promise<AccountSnapshot> {
    return this.snapshot("account_email_start", { email });
  }

  startSocial(provider: "google" | "microsoft"): Promise<AccountSnapshot> {
    return this.snapshot("account_social_start", { provider });
  }

  pollEmail(): Promise<AccountSnapshot> {
    return this.snapshot("account_email_poll");
  }

  cancelAuth(): Promise<AccountSnapshot> {
    return this.snapshot("account_auth_cancel");
  }

  activateFree(): Promise<AccountSnapshot> {
    return this.snapshot("account_activate_free");
  }

  checkout(tier: PurchasableTier): Promise<AccountSnapshot> {
    return this.snapshot("account_checkout", { tier });
  }

  async portal(): Promise<AccountOpenResult> {
    const result = record(await this.transport.invoke("account_portal"), "portal result");
    if (result.opened !== true) throw new Error("Invalid native portal result.");
    return { opened: true };
  }

  refresh(): Promise<AccountSnapshot> {
    return this.snapshot("account_refresh");
  }

  logout(): Promise<AccountSnapshot> {
    return this.snapshot("account_logout");
  }

  async usage(): Promise<AccountUsageSnapshot> {
    return parseAccountUsage(await this.transport.invoke("account_usage"));
  }
}
