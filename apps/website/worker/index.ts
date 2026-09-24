import { type DownloadEnv, downloadDepsFromEnv, handleDownload } from "./downloads";
import { depsFromEnv, type Env, handleRequest } from "./lib/router";

export default {
  async fetch(request, env) {
    // Desktop downloads (/download/windows-x64, /download/<version>/<file>, /releases/latest.json)
    // are served from R2; everything else goes through the site router.
    const download = await handleDownload(request, downloadDepsFromEnv(env));
    return download ?? handleRequest(request, depsFromEnv(env));
  },
} satisfies ExportedHandler<Env & DownloadEnv>;
