/**
 * Email transports, chosen by the Worker var EMAIL_TRANSPORT:
 *
 *   resend   production: Resend's REST API (no SDK), authenticated with the RESEND_API_KEY secret.
 *   capture  tests: POSTs the message as JSON to EMAIL_CAPTURE_URL, which must be a loopback
 *            address (the Playwright mail sink). Never reaches a real inbox.
 *   log      local development: writes the message, links included, to the local console.
 *
 * `capture` and `log` only run with a loopback EMAIL_LINK_ORIGIN (the router checks) and
 * `capture` only posts to a loopback sink, so a misconfigured production deployment fails
 * loudly instead of silently not sending.
 * No transport ever returns provider error text to callers: only a coarse reason.
 */
import { EMAIL_FROM, EMAIL_REPLY_TO } from "../../src/lib/site";

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
/** Upper bound for one send; the visitor waits for it, so keep it well under a minute. */
export const SEND_TIMEOUT_MS = 8000;

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Optional Resend Idempotency-Key, so a duplicated request cannot send twice. */
  idempotencyKey?: string;
}

export type SendFailure = "not_configured" | "rejected" | "timeout" | "network";
export type SendResult = { ok: true } | { ok: false; reason: SendFailure; status?: number };

export type TransportName = "resend" | "capture" | "log";

export interface Mailer {
  readonly transport: TransportName | "invalid";
  send(email: OutgoingEmail): Promise<SendResult>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function failureOf(error: unknown): SendFailure {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    ? "timeout"
    : "network";
}

/** Resend REST API. The key is read here and sent only in the Authorization header. */
export function resendMailer(
  apiKey: string | undefined,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  timeoutMs = SEND_TIMEOUT_MS,
): Mailer {
  return {
    transport: "resend",
    async send(email) {
      if (!apiKey) return { ok: false, reason: "not_configured" };
      const headers: Record<string, string> = {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "user-agent": "kalcoded.com-worker",
      };
      if (email.idempotencyKey) headers["idempotency-key"] = email.idempotencyKey;
      try {
        const response = await fetchImpl(RESEND_ENDPOINT, {
          method: "POST",
          headers,
          body: JSON.stringify({
            from: EMAIL_FROM,
            to: [email.to],
            reply_to: EMAIL_REPLY_TO,
            subject: email.subject,
            text: email.text,
            html: email.html,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Drain the body so the connection is released; its content (which may echo the
        // address) is never logged or returned.
        await response.body?.cancel();
        return response.ok ? { ok: true } : { ok: false, reason: "rejected", status: response.status };
      } catch (error) {
        return { ok: false, reason: failureOf(error) };
      }
    },
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Test transport: hands the message to a local mail sink. */
export function captureMailer(
  captureUrl: string | undefined,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  timeoutMs = SEND_TIMEOUT_MS,
): Mailer {
  let target: URL | null = null;
  try {
    target = captureUrl ? new URL(captureUrl) : null;
  } catch {
    target = null;
  }
  const usable = target !== null && target.protocol === "http:" && isLoopbackHost(target.hostname);
  return {
    transport: "capture",
    async send(email) {
      if (!usable || !target) return { ok: false, reason: "not_configured" };
      try {
        const response = await fetchImpl(target.href, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            from: EMAIL_FROM,
            to: [email.to],
            reply_to: EMAIL_REPLY_TO,
            subject: email.subject,
            text: email.text,
            html: email.html,
            idempotencyKey: email.idempotencyKey ?? null,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.body?.cancel();
        return response.ok ? { ok: true } : { ok: false, reason: "rejected", status: response.status };
      } catch (error) {
        return { ok: false, reason: failureOf(error) };
      }
    },
  };
}

/** Local development transport: prints the message so the links can be opened by hand. */
export function logMailer(print: (line: string) => void): Mailer {
  return {
    transport: "log",
    async send(email) {
      print(`[email:log] to=${redactEmail(email.to)} subject=${JSON.stringify(email.subject)}\n${email.text}`);
      return { ok: true };
    },
  };
}

function invalidMailer(): Mailer {
  return {
    transport: "invalid",
    async send() {
      return { ok: false, reason: "not_configured" };
    },
  };
}

export interface MailEnv {
  EMAIL_TRANSPORT?: string;
  RESEND_API_KEY?: string;
  EMAIL_CAPTURE_URL?: string;
}

export function mailerFromEnv(env: MailEnv, print: (line: string) => void): Mailer {
  switch ((env.EMAIL_TRANSPORT ?? "resend").trim().toLowerCase()) {
    case "resend":
      return resendMailer(env.RESEND_API_KEY);
    case "capture":
      return captureMailer(env.EMAIL_CAPTURE_URL);
    case "log":
      return logMailer(print);
    default:
      return invalidMailer();
  }
}

/** `n•••@example.com`: enough to recognise in local output, never a full address. */
export function redactEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}
