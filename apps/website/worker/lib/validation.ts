import { isValidEmail, normalizeEmail } from "../../src/lib/email";
import { isKnownPagePath } from "../../src/lib/site";
import { isTokenFormat } from "./tokens";

export interface SignupInput {
  email: string;
  source: string | null;
  /** True when the honeypot field was filled in (a bot); the request is acknowledged but ignored. */
  isBot: boolean;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string; message: string };

const INVALID_EMAIL = {
  ok: false,
  error: "invalid_email",
  message: "Enter a complete email address, like name@example.com.",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEmail(body: Record<string, unknown>): Validation<string> {
  const raw = body.email;
  if (typeof raw !== "string") {
    return INVALID_EMAIL;
  }
  const email = normalizeEmail(raw);
  return isValidEmail(email) ? { ok: true, value: email } : INVALID_EMAIL;
}

export function validateSignup(body: unknown): Validation<SignupInput> {
  if (!isRecord(body)) {
    return { ok: false, error: "invalid_body", message: "The request body must be a JSON object." };
  }

  const website = body.website;
  if (website !== undefined && typeof website !== "string") {
    return { ok: false, error: "invalid_body", message: "The request body is not valid." };
  }
  if (typeof website === "string" && website.trim().length > 0) {
    // Honeypot filled: acknowledge like any other signup, validate nothing, store nothing.
    return { ok: true, value: { email: "", source: null, isBot: true } };
  }

  const email = readEmail(body);
  if (!email.ok) {
    return email;
  }

  const source = body.source;
  if (source !== undefined && source !== null) {
    if (typeof source !== "string" || !isKnownPagePath(source)) {
      return { ok: false, error: "invalid_source", message: "The form source is not recognised." };
    }
  }

  return {
    ok: true,
    value: { email: email.value, source: typeof source === "string" ? source : null, isBot: false },
  };
}

export function validateRemoval(body: unknown): Validation<{ email: string }> {
  if (!isRecord(body)) {
    return { ok: false, error: "invalid_body", message: "The request body must be a JSON object." };
  }
  const email = readEmail(body);
  return email.ok ? { ok: true, value: { email: email.value } } : email;
}

/** Body of the confirm and remove-confirm endpoints: `{ token }`, shaped like an issued code. */
export function validateToken(body: unknown): Validation<{ token: string }> {
  if (!isRecord(body)) {
    return { ok: false, error: "invalid_body", message: "The request body must be a JSON object." };
  }
  return isTokenFormat(body.token)
    ? { ok: true, value: { token: body.token } }
    : { ok: false, error: "invalid_link", message: "This link is not complete. Open it again from the email." };
}
