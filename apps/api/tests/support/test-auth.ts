/**
 * TEST-ONLY authenticator. It trusts a header naming the account — exactly what production must
 * never do — so it lives under tests/ and is never imported by `worker/index.ts`
 * (tests/unit/source-invariants.test.ts enforces that).
 */
import type { Authenticator } from "../../worker/lib/auth";

export const TEST_ACCOUNT_HEADER = "x-kalcode-test-account";

export const TEST_ONLY_AUTHENTICATOR: Authenticator = {
  async authenticate(request) {
    const accountId = request.headers.get(TEST_ACCOUNT_HEADER);
    return accountId ? { ok: true, accountId } : { ok: false };
  },
};
