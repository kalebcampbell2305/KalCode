/**
 * Caller authentication.
 *
 * Production uses hashed, expiring D1 sessions only when passwordless email or the optional OAuth
 * path is fully configured. `SIGN_IN_UNAVAILABLE` remains the fail-closed configuration fallback.
 * Tests use their own implementation (`tests/support/test-auth.ts`), which is never imported by
 * the Worker entry point.
 *
 * An authenticator must only ever return an account id taken from a credential the server issued or
 * verified — never an id, email or tier supplied by the client.
 */

import type { AccountStore } from "./account-store";
import { sha256Base64Url } from "./crypto";

export type AuthResult = { ok: true; accountId: string } | { ok: false };

export interface Authenticator {
  authenticate(request: Request): Promise<AuthResult>;
}

export const SIGN_IN_UNAVAILABLE: Authenticator = {
  async authenticate() {
    return { ok: false };
  },
};

const BEARER = /^Bearer (kcs_[A-Za-z0-9_-]{43})$/;
const SESSION = /^kcs_[A-Za-z0-9_-]{43}$/;
export const SESSION_COOKIE = "__Host-kalcode_session";

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function sessionToken(request: Request): string | null {
  const bearer = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
  if (bearer) return bearer;
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  for (const part of cookies) {
    const [name, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (name === SESSION_COOKIE && SESSION.test(value)) return value;
  }
  return null;
}

export function sessionAuthenticator(store: AccountStore, now: () => Date): Authenticator {
  return {
    async authenticate(request) {
      const token = sessionToken(request);
      if (!token) return { ok: false };
      const accountId = await store.activeSession(await sha256Base64Url(token), now().toISOString());
      return accountId ? { ok: true, accountId } : { ok: false };
    },
  };
}
