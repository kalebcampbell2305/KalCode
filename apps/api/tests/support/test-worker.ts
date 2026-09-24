/**
 * TEST-ONLY Worker entry for integration tests: the production router, store and key handling,
 * with the test authenticator in place of the (not yet existing) sign-in. Never deployed —
 * `wrangler.jsonc` points at `worker/index.ts`.
 */
import type { Env } from "../../worker/lib/env";
import { depsFromEnv } from "../../worker/lib/env";
import { handleRequest } from "../../worker/lib/router";
import { TEST_ONLY_AUTHENTICATOR } from "./test-auth";

export default {
  fetch(request, env) {
    return handleRequest(request, { ...depsFromEnv(env), auth: TEST_ONLY_AUTHENTICATOR });
  },
} satisfies ExportedHandler<Env>;
