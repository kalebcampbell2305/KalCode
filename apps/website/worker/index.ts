import { type DownloadEnv, downloadDepsFromEnv, handleDownload } from "./downloads";
import { scheduledPurge } from "./lib/early-access";
import { depsFromEnv, type Env, handleRequest } from "./lib/router";

export default {
  async fetch(request, env) {
    // Desktop downloads (/download/windows-x64, /download/<version>/<file>, /releases/latest.json)
    // are served from R2; everything else goes through the site router.
    const download = await handleDownload(request, downloadDepsFromEnv(env));
    return download ?? handleRequest(request, depsFromEnv(env));
  },

  /**
   * Cron trigger (wrangler.jsonc `triggers.crons`): deletes expired links and unconfirmed
   * sign-ups, so they are gone on time even when nobody uses the forms.
   */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(scheduledPurge(depsFromEnv(env)));
  },
} satisfies ExportedHandler<Env & DownloadEnv>;
