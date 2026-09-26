/**
 * Early-access double opt-in: what happens between a validated request and the HTTP response.
 * The router (router.ts) owns HTTP concerns; this module owns the list, the links and the email.
 *
 *   join     → pending row + confirmation email (or, for a confirmed address, an "already on the
 *              list" email), throttled per address and budgeted per day
 *   confirm  → single-use link marks the address confirmed
 *   remove   → removal email only if the address is on the list; its single-use link deletes
 *              the row and every link permanently
 *
 * Any failure to send undoes what the attempt wrote (new row, links, throttle and budget slots),
 * so the person can simply try again.
 */
import { EARLY_ACCESS_EMAIL } from "../../src/lib/site";
import {
  actionUrl,
  type RenderedEmail,
  renderAlreadyConfirmedEmail,
  renderConfirmEmail,
  renderRemovalEmail,
} from "./emails";
import type { Mailer } from "./mailer";
import type { AddressClaim, EarlyAccessStore, MarketingSendClaim, NewSignup, Subscriber, TokenRecord } from "./store";
import { hashToken } from "./tokens";

export interface FlowDeps {
  store: EarlyAccessStore;
  mailer: Mailer;
  now: () => Date;
  log: (entry: Record<string, string>) => void;
  newToken: () => string;
  /** Site-wide cap on emails per UTC day. */
  dailyEmailLimit: number;
}

export type SendOutcome = "sent" | "throttled" | "budget_exhausted" | "send_failed" | "store_failed";
export type RemovalOutcome = SendOutcome | "not_listed";

export const LINK_TTL_MS = EARLY_ACCESS_EMAIL.linkTtlHours * 60 * 60 * 1000;
export const THROTTLE = {
  minIntervalMs: EARLY_ACCESS_EMAIL.minIntervalMinutes * 60 * 1000,
  dailyPerAddress: EARLY_ACCESS_EMAIL.dailyPerAddress,
} as const;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** Housekeeping on every write. A failure here never blocks the request. */
async function purge(deps: FlowDeps, now: Date): Promise<void> {
  try {
    await deps.store.purgeExpired(now, new Date(now.getTime() - LINK_TTL_MS));
  } catch (error) {
    deps.log({ level: "warn", event: "early_access.purge_failed", error: errorName(error) });
  }
}

/** Runs one scheduled cleanup (the Worker's cron trigger). */
export async function scheduledPurge(deps: Pick<FlowDeps, "store" | "now" | "log">): Promise<void> {
  const now = deps.now();
  try {
    await deps.store.purgeExpired(now, new Date(now.getTime() - LINK_TTL_MS));
  } catch (error) {
    deps.log({ level: "error", event: "early_access.purge_failed", error: errorName(error) });
    throw error; // marks the cron run as failed in the dashboard
  }
  deps.log({ level: "info", event: "early_access.purged" });
}

interface Attempt {
  subscriber: Subscriber;
  to: string;
  /** Row inserted by this request: deleted again if the email cannot be sent. */
  created: boolean;
  purposes: readonly ("confirm" | "remove")[];
  render: (urls: { confirmUrl?: string; removeUrl: string }) => RenderedEmail;
  kind: string;
}

/**
 * Claims the throttle and budget, stores the link hashes, sends, and undoes all of it if anything
 * after the throttle claim fails. Log lines name the kind of email and the outcome, never the
 * address or a link.
 */
async function sendWithLinks(deps: FlowDeps, linkOrigin: string, attempt: Attempt): Promise<SendOutcome> {
  const { store } = deps;
  const now = deps.now();
  const claim: AddressClaim | null = await store.claimAddressSend(attempt.subscriber.id, now, THROTTLE);
  if (!claim) {
    // Emailed recently (or a concurrent request for the same address is sending right now).
    deps.log({ level: "info", event: "early_access.email_throttled", kind: attempt.kind });
    return "throttled";
  }

  let outcome: SendOutcome = "send_failed";
  let marketingClaim: MarketingSendClaim | null = null;
  let providerStarted = false;
  const records: TokenRecord[] = [];
  const entry: Record<string, string> = { kind: attempt.kind, transport: deps.mailer.transport };
  try {
    marketingClaim = await store.claimMarketingSend(now, deps.dailyEmailLimit);
    if (!marketingClaim) {
      outcome = "budget_exhausted";
    } else {
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + LINK_TTL_MS).toISOString();
      const codes: Partial<Record<"confirm" | "remove", string>> = {};
      for (const purpose of attempt.purposes) {
        const code = deps.newToken();
        codes[purpose] = code;
        records.push({
          hash: await hashToken(code),
          subscriberId: attempt.subscriber.id,
          purpose,
          createdAt,
          expiresAt,
        });
      }
      await store.addTokens(records);
      const removeUrl = actionUrl(linkOrigin, EARLY_ACCESS_EMAIL.removePath, codes.remove ?? "");
      const confirmUrl = codes.confirm
        ? actionUrl(linkOrigin, EARLY_ACCESS_EMAIL.confirmPath, codes.confirm)
        : undefined;
      providerStarted = true;
      const result = await deps.mailer.send({
        to: attempt.to,
        ...attempt.render(confirmUrl ? { confirmUrl, removeUrl } : { removeUrl }),
        // Derived from a fresh random link hash: unique per attempt, reveals nothing.
        idempotencyKey: `early-access-${records[0]?.hash.slice(0, 32) ?? createdAt}`,
      });
      if (result.ok) {
        try {
          await store.finalizeMarketingSend(marketingClaim, "sent");
        } catch (error) {
          deps.log({ level: "error", event: "early_access.budget_finalize_failed", error: errorName(error) });
        }
        deps.log({ level: "info", event: "early_access.email_sent", ...entry });
        return "sent";
      }
      entry.reason = result.reason;
      if (result.status !== undefined) entry.status = String(result.status);
      if (result.reason === "network" || result.reason === "timeout") {
        try {
          await store.finalizeMarketingSend(marketingClaim, "ambiguous");
        } catch (error) {
          deps.log({ level: "error", event: "early_access.budget_finalize_failed", error: errorName(error) });
        }
        deps.log({ level: "warn", event: "early_access.email_failed", ...entry });
        return "send_failed";
      }
    }
  } catch (error) {
    if (providerStarted && marketingClaim) {
      try {
        await store.finalizeMarketingSend(marketingClaim, "ambiguous");
      } catch (finalizeError) {
        deps.log({ level: "error", event: "early_access.budget_finalize_failed", error: errorName(finalizeError) });
      }
      deps.log({ level: "warn", event: "early_access.email_failed", reason: "ambiguous", error: errorName(error) });
      return "send_failed";
    }
    outcome = "store_failed";
    entry.reason = "store";
    entry.error = errorName(error);
  }

  // Undo, so nothing half-created blocks a retry. Each step is independent and best effort.
  const undo: [string, () => Promise<void>][] = [["address_slot", () => store.releaseAddressSend(claim)]];
  if (records.length > 0) undo.push(["tokens", () => store.deleteTokens(records.map((record) => record.hash))]);
  if (marketingClaim) undo.push(["daily_slot", () => store.finalizeMarketingSend(marketingClaim, "rejected")]);
  if (attempt.created) undo.push(["row", () => store.deleteCreated(attempt.subscriber.id)]);
  for (const [step, run] of undo) {
    try {
      await run();
    } catch (error) {
      deps.log({ level: "error", event: "early_access.undo_failed", step, error: errorName(error) });
    }
  }
  const event = outcome === "budget_exhausted" ? "early_access.email_budget_exhausted" : "early_access.email_failed";
  deps.log({ level: outcome === "budget_exhausted" ? "warn" : "error", event, ...entry });
  return outcome;
}

/** Join: always answers the same way to the visitor; the email differs by the address's state. */
export async function requestSignup(deps: FlowDeps, signup: NewSignup, linkOrigin: string): Promise<SendOutcome> {
  await purge(deps, deps.now());
  const { subscriber, created } = await deps.store.addPending(signup);
  const hours = EARLY_ACCESS_EMAIL.linkTtlHours;
  if (subscriber.status === "confirmed") {
    return sendWithLinks(deps, linkOrigin, {
      subscriber,
      to: signup.email,
      created,
      purposes: ["remove"],
      kind: "already_confirmed",
      render: ({ removeUrl }) => renderAlreadyConfirmedEmail({ removeUrl, hours }),
    });
  }
  return sendWithLinks(deps, linkOrigin, {
    subscriber,
    to: signup.email,
    created,
    purposes: ["confirm", "remove"],
    kind: "confirm",
    render: ({ confirmUrl, removeUrl }) => renderConfirmEmail({ confirmUrl: confirmUrl ?? "", removeUrl, hours }),
  });
}

/** Removal request: emails a removal link only to an address that is on the list. */
export async function requestRemoval(deps: FlowDeps, email: string, linkOrigin: string): Promise<RemovalOutcome> {
  await purge(deps, deps.now());
  const subscriber = await deps.store.find(email);
  if (!subscriber) return "not_listed";
  return sendWithLinks(deps, linkOrigin, {
    subscriber,
    to: email,
    created: false,
    purposes: ["remove"],
    kind: "removal",
    render: ({ removeUrl }) => renderRemovalEmail({ removeUrl, hours: EARLY_ACCESS_EMAIL.linkTtlHours }),
  });
}

export async function confirmWithToken(deps: FlowDeps, token: string): Promise<boolean> {
  const confirmed = await deps.store.confirmByToken(await hashToken(token), deps.now());
  deps.log({ level: "info", event: "early_access.confirm", outcome: confirmed ? "confirmed" : "invalid_link" });
  return confirmed;
}

export async function removeWithToken(deps: FlowDeps, token: string): Promise<boolean> {
  const removed = await deps.store.removeByToken(await hashToken(token), deps.now());
  deps.log({ level: "info", event: "early_access.remove", outcome: removed ? "removed" : "invalid_link" });
  return removed;
}
