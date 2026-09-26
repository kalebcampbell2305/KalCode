import { isValidEmail, normalizeEmail } from "../../src/lib/email";
import type { Mailer } from "./mailer";
import { EMAIL_ADMISSION_LIMITS, emailAdmissionCaps } from "./store";
import { hashToken } from "./tokens";

export type AccountMailPurpose = "signin" | "delete";
export type AccountMailDispatchState = "claimed" | "sent" | "ambiguous" | "rejected";
export type AccountMailOutcome = "sent" | "ambiguous" | "rejected" | "budget_exhausted" | "invalid";

export interface AccountMailRpcRequest {
  purpose: AccountMailPurpose;
  recipient: string;
  oneTimeProof: string;
  networkHash: string;
  recipientHash: string;
}

export interface AccountMailRpcResponse {
  outcome: AccountMailOutcome;
}

export type AccountMailClaim =
  | { kind: "claimed" }
  | { kind: "existing"; state: AccountMailDispatchState }
  | { kind: "budget_exhausted" };

export interface AccountMailClaimInput {
  proofHash: string;
  purpose: AccountMailPurpose;
  networkHash: string;
  recipientHash: string;
  now: Date;
  dailyLimit: number;
}

export interface AccountMailDispatchStore {
  claim(input: AccountMailClaimInput): Promise<AccountMailClaim>;
  finalize(proofHash: string, state: Exclude<AccountMailDispatchState, "claimed">, now: Date): Promise<void>;
}

export interface AccountMailDeps {
  store: AccountMailDispatchStore;
  mailer: Mailer;
  now: () => Date;
  dailyEmailLimit: number;
  log: (entry: Record<string, string>) => void;
}

interface DispatchRow {
  state: AccountMailDispatchState;
}

const OPAQUE_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function existingDispatch(db: D1Database, proofHash: string): Promise<DispatchRow | null> {
  return db
    .prepare("SELECT state FROM account_email_dispatches WHERE proof_hash = ?1")
    .bind(proofHash)
    .first<DispatchRow>();
}

export function d1AccountMailDispatchStore(db: D1Database): AccountMailDispatchStore {
  return {
    async claim({ proofHash, purpose, networkHash, recipientHash, now, dailyLimit }) {
      const existing = await existingDispatch(db, proofHash);
      if (existing) return { kind: "existing", state: existing.state };
      const caps = emailAdmissionCaps(dailyLimit);
      if (caps.hard <= 0) return { kind: "budget_exhausted" };
      try {
        await db
          .prepare(
            "INSERT INTO account_email_dispatches " +
              "(proof_hash, purpose, claimed_day, budget_limit, state, created_at, network_hash, recipient_hash, " +
              "non_deletion_limit, network_limit, recipient_limit) " +
              "VALUES (?1, ?2, ?3, ?4, 'claimed', ?5, ?6, ?7, ?8, ?9, ?10)",
          )
          .bind(
            proofHash,
            purpose,
            utcDay(now),
            caps.hard,
            now.toISOString(),
            networkHash,
            recipientHash,
            caps.nonDeletion,
            EMAIL_ADMISSION_LIMITS.accountNetworkPerPurposeDaily,
            EMAIL_ADMISSION_LIMITS.accountRecipientPerPurposeDaily,
          )
          .run();
        return { kind: "claimed" };
      } catch {
        // A concurrent duplicate is replay-safe. Any other constraint/storage failure is a
        // fail-closed budget denial; never send without a durable unique claim.
        const raced = await existingDispatch(db, proofHash).catch(() => null);
        return raced ? { kind: "existing", state: raced.state } : { kind: "budget_exhausted" };
      }
    },

    async finalize(proofHash, state, now) {
      await db
        .prepare(
          "UPDATE account_email_dispatches SET state = ?2, completed_at = ?3 " +
            "WHERE proof_hash = ?1 AND state = 'claimed'",
        )
        .bind(proofHash, state, now.toISOString())
        .run();
    },
  };
}

export async function purgeAccountMailDispatches(db: D1Database, before: Date): Promise<void> {
  await db.prepare("DELETE FROM account_email_dispatches WHERE created_at < ?1").bind(before.toISOString()).run();
}

function validRequest(input: unknown): input is AccountMailRpcRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "networkHash,oneTimeProof,purpose,recipient,recipientHash") return false;
  if (record.purpose !== "signin" && record.purpose !== "delete") return false;
  if (typeof record.recipient !== "string" || record.recipient !== normalizeEmail(record.recipient)) return false;
  return (
    isValidEmail(record.recipient) &&
    typeof record.oneTimeProof === "string" &&
    OPAQUE_32_BYTES.test(record.oneTimeProof) &&
    typeof record.networkHash === "string" &&
    OPAQUE_32_BYTES.test(record.networkHash) &&
    typeof record.recipientHash === "string" &&
    OPAQUE_32_BYTES.test(record.recipientHash)
  );
}

function message(purpose: AccountMailPurpose, proof: string) {
  const url = new URL("https://kalcoded.com/account");
  // Fragments do not reach the website/CDN request log. The account page removes it immediately.
  url.hash = new URLSearchParams({ verify: proof }).toString();
  const href = url.toString();
  if (purpose === "delete") {
    return {
      subject: "Confirm deletion of your KalCode account",
      text: `Open this one-time link to delete your account from KalCode:\n\n${href}\n\nIt expires in 10 minutes. If you did not request it, ignore this email.`,
      html:
        '<div style="font-family:Segoe UI,Arial,sans-serif;background:#05080f;color:#f6f8ff;padding:32px">' +
        '<div style="max-width:560px;margin:auto"><div style="letter-spacing:.12em;font-weight:700">KALCODE</div>' +
        '<h1 style="font-size:24px">Delete your KalCode account</h1><p>Open the one-time link below. It expires in 10 minutes.</p>' +
        `<p><a href="${href}" style="display:inline-block;background:#2f7cff;color:white;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Confirm account deletion</a></p>` +
        '<p style="color:#99a7bd;font-size:13px">If you did not request this, ignore this email.</p></div></div>',
    };
  }
  return {
    subject: "Sign in to KalCode",
    text: `Open this one-time link to sign in to KalCode:\n\n${href}\n\nIt expires in 10 minutes. If you did not request it, ignore this email.`,
    html:
      '<div style="font-family:Segoe UI,Arial,sans-serif;background:#05080f;color:#f6f8ff;padding:32px">' +
      '<div style="max-width:560px;margin:auto"><div style="letter-spacing:.12em;font-weight:700">KALCODE</div>' +
      '<h1 style="font-size:24px">Sign in to KalCode</h1><p>Open the one-time link below. It expires in 10 minutes.</p>' +
      `<p><a href="${href}" style="display:inline-block;background:#2f7cff;color:white;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Continue to KalCode</a></p>` +
      '<p style="color:#99a7bd;font-size:13px">If you did not request this, ignore this email.</p></div></div>',
  };
}

function priorOutcome(state: AccountMailDispatchState): AccountMailOutcome {
  return state === "claimed" ? "ambiguous" : state;
}

/** Internal service-binding operation. It is deliberately not connected to the public router. */
export async function sendAccountEmail(input: unknown, deps: AccountMailDeps): Promise<AccountMailRpcResponse> {
  if (!validRequest(input)) return { outcome: "invalid" };
  const now = deps.now();
  const proofHash = await hashToken(input.oneTimeProof);
  const claim = await deps.store.claim({
    proofHash,
    purpose: input.purpose,
    networkHash: input.networkHash,
    recipientHash: input.recipientHash,
    now,
    dailyLimit: deps.dailyEmailLimit,
  });
  if (claim.kind === "existing") return { outcome: priorOutcome(claim.state) };
  if (claim.kind === "budget_exhausted") return { outcome: "budget_exhausted" };

  const result = await deps.mailer.send({
    to: input.recipient,
    ...message(input.purpose, input.oneTimeProof),
    idempotencyKey: `account-${input.purpose}-${proofHash.slice(0, 32)}`,
  });
  const outcome: Exclude<AccountMailOutcome, "budget_exhausted" | "invalid"> = result.ok
    ? "sent"
    : result.reason === "network" || result.reason === "timeout"
      ? "ambiguous"
      : "rejected";
  await deps.store.finalize(proofHash, outcome, now);
  deps.log({
    level: outcome === "sent" ? "info" : outcome === "ambiguous" ? "warn" : "error",
    event: "account_email.dispatch",
    purpose: input.purpose,
    outcome,
    transport: deps.mailer.transport,
  });
  return { outcome };
}
