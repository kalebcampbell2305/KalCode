import { WorkerEntrypoint } from "cloudflare:workers";
import { componentDepsFromEnv, handleComponent } from "./components";
import {
  countServedRequest,
  type DistributionStatsInput,
  distributionStats,
  isAnalyticsRange,
  purgeDistributionEvents,
  validTzOffset,
} from "./distribution";
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

/**
 * Internal-only named RPC entrypoint for the owner dashboard. Reachable only through the
 * kalcode-api service binding, which checks the caller's OWNER grant first (docs/OWNER_ANALYTICS.md).
 * Returns anonymous aggregate counts only.
 */
export class DistributionStatsEntrypoint extends WorkerEntrypoint<WorkerEnv> {
  async distributionStats(input: DistributionStatsInput) {
    if (!isAnalyticsRange(input?.range) || !validTzOffset(input?.tzOffsetMinutes)) {
      throw new Error("invalid distribution stats input");
    }
    return distributionStats(this.env.DB, { range: input.range, tzOffsetMinutes: input.tzOffsetMinutes }, new Date());
  }
}

// Structured logs only. Never IP addresses, User-Agent strings or request headers.
// biome-ignore lint/suspicious/noConsole: console is the Workers structured-logging sink.
const log = (entry: Record<string, string>) => console.log(JSON.stringify(entry));

export default {
  async fetch(request, env, ctx) {
    const component = await handleComponent(request, componentDepsFromEnv(env));
    if (component) return component;
    // Desktop downloads (/download/windows-x64, /download/<version>/<file>, /releases/latest.json)
    // are served from R2; everything else goes through the site router.
    const download = await handleDownload(request, downloadDepsFromEnv(env));
    if (download) {
      // Anonymous distribution counts, recorded after the response is chosen (distribution.ts).
      ctx.waitUntil(countServedRequest(env.DB, request, download, new Date(), log));
      return download;
    }
    return handleRequest(request, depsFromEnv(env));
  },

  /**
   * Cron trigger (wrangler.jsonc `triggers.crons`): deletes expired links and unconfirmed
   * sign-ups, so they are gone on time even when nobody uses the forms.
   */
  async scheduled(_controller, env, ctx) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
    ctx.waitUntil(
      Promise.all([
        scheduledPurge(depsFromEnv(env)),
        purgeAccountMailDispatches(env.DB, thirtyDaysAgo),
        purgeDistributionEvents(env.DB, new Date()),
      ]),
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
