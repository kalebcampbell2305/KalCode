import { depsFromEnv, type Env } from "./lib/env";
import { apiError } from "./lib/http";
import { handleRequest } from "./lib/router";

export default {
  fetch(request, env) {
    if (env.ACCOUNT_SCHEMA_MAINTENANCE === "true") {
      return apiError(
        503,
        "account_maintenance",
        "Account services are temporarily unavailable. Please retry shortly.",
        {
          "retry-after": "60",
        },
      );
    }
    return handleRequest(request, depsFromEnv(env));
  },

  /** Daily cron (wrangler.jsonc): stores the day's aggregate revenue snapshot for the owner dashboard. */
  async scheduled(_controller, env, ctx) {
    if (env.ACCOUNT_SCHEMA_MAINTENANCE === "true") return;
    ctx.waitUntil(depsFromEnv(env).insights?.snapshot() ?? Promise.resolve());
  },
} satisfies ExportedHandler<Env>;
