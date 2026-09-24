/** The D1 binding of a local test database, in Node, through wrangler's getPlatformProxy. */
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { API_DIR } from "./wrangler";

export async function openDatabase(persistTo: string) {
  // `wrangler --persist-to <dir>` stores state under <dir>/v3; getPlatformProxy takes that path.
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(API_DIR, "wrangler.jsonc"),
    persist: { path: join(persistTo, "v3") },
  });
  return { db: proxy.env.DB, dispose: proxy.dispose };
}
