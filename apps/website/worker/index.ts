import { WorkerEntrypoint } from "cloudflare:workers";
import { type DownloadEnv, downloadDepsFromEnv, handleDownload } from "./downloads";
import {
  type AccountMailRpcRequest,
  d1AccountMailDispatchStore,
  purgeAccountMailDispatches,
  sendAccountEmail,
} from "./lib/account-mail-service";
import { scheduledPurge } from "./lib/early-access";
import { resendMailer } from "./lib/mailer";
import { dailyEmailLimit, depsFromEnv, type Env, handleRequest } from "./lib/router";

type WorkerEnv = Env & DownloadEnv;

/** Internal-only named RPC entrypoint. It has no `fetch` method and no public HTTP route. */
export class AccountMailEntrypoint extends WorkerEntrypoint<WorkerEnv> {
  async sendAccountEmail(request: AccountMailRpcRequest) {
    return sendAccountEmail(request, {
      store: d1AccountMailDispatchStore(this.env.DB),
      // The internal production RPC never enables the local log/capture transports, which could
      // expose a one-time proof outside their explicitly loopback-only development paths.
      mailer: resendMailer(this.env.RESEND_API_KEY),
      now: () => new Date(),
      dailyEmailLimit: dailyEmailLimit(this.env.EMAIL_DAILY_LIMIT),
      // Structured logs only. No recipient, proof or proof hash is included.
      // biome-ignore lint/suspicious/noConsole: console is the Workers structured-logging sink.
      log: (entry) => console.log(JSON.stringify(entry)),
    });
  }
}

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
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
    ctx.waitUntil(Promise.all([scheduledPurge(depsFromEnv(env)), purgeAccountMailDispatches(env.DB, thirtyDaysAgo)]));
  },
} satisfies ExportedHandler<WorkerEnv>;
