/** Production wiring: bindings and secrets → handler dependencies. */

import { SIGN_IN_UNAVAILABLE } from "./auth";
import { importSigningKey, parsePreviousPublicKeys } from "./keys";
import type { Deps } from "./router";
import { d1Store } from "./store";
import type { EntitlementSigningKey } from "./token";

export interface Env {
  DB: D1Database;
  /** Worker secret: Ed25519 private JWK with `kid`. Absent → entitlement endpoint answers 503. */
  ENTITLEMENT_SIGNING_KEY?: string;
  /** JSON array of retired public keys still published during rotation. */
  ENTITLEMENT_PREVIOUS_PUBLIC_KEYS?: string;
}

// Imported once per isolate for each distinct secret value.
let cachedSecret: string | undefined;
let cachedKey: Promise<EntitlementSigningKey> | undefined;

function loadSigningKey(secret: string | undefined): Promise<EntitlementSigningKey | null> {
  if (!secret) {
    return Promise.resolve(null);
  }
  if (secret !== cachedSecret || !cachedKey) {
    cachedSecret = secret;
    cachedKey = importSigningKey(secret);
    // A bad secret must not be cached forever: drop it so a fixed secret is picked up.
    cachedKey.catch(() => {
      if (cachedSecret === secret) {
        cachedSecret = undefined;
        cachedKey = undefined;
      }
    });
  }
  return cachedKey;
}

export function depsFromEnv(env: Env): Deps {
  return {
    store: d1Store(env.DB),
    // Sign-in lands in campaign Z13. Until then no request is ever authenticated in production.
    auth: SIGN_IN_UNAVAILABLE,
    signingKey: () => loadSigningKey(env.ENTITLEMENT_SIGNING_KEY),
    previousPublicKeys: () => parsePreviousPublicKeys(env.ENTITLEMENT_PREVIOUS_PUBLIC_KEYS),
    now: () => new Date(),
    // Structured logs only. Never log tokens, keys, emails or account ids.
    // biome-ignore lint/suspicious/noConsole: console is the Workers structured-logging sink.
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}
