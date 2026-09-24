/**
 * Caller authentication.
 *
 * KalCode has no sign-in yet (it lands in campaign Z13). Until then the only production
 * authenticator is `SIGN_IN_UNAVAILABLE`, which rejects every request, so account-scoped
 * endpoints answer 401 in every deployed configuration. Tests use their own implementation
 * (`tests/support/test-auth.ts`), which is never imported by the Worker entry point.
 *
 * Z13 replaces `SIGN_IN_UNAVAILABLE` in `env.ts` with a real session verifier. An authenticator
 * must only ever return an account id taken from a credential the server itself issued or
 * verified — never an id, email or tier supplied by the client.
 */

export type AuthResult = { ok: true; accountId: string } | { ok: false };

export interface Authenticator {
  authenticate(request: Request): Promise<AuthResult>;
}

export const SIGN_IN_UNAVAILABLE: Authenticator = {
  async authenticate() {
    return { ok: false };
  },
};
