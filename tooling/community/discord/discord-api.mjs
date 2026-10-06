// A small Discord REST client: rate-limit aware (429 retry_after, bucket exhaustion), retries 5xx
// with backoff, writes an audit-log reason on every change, and never puts the token in a log line
// or an error message.

export const API_BASE = "https://discord.com/api/v10";
const UA = "DiscordBot (https://kalcoded.com, 1) KalCodeCommunity";

export class DiscordError extends Error {
  constructor(method, path, status, body) {
    const detail = body?.message ? `${body.message}${body.code ? ` (code ${body.code})` : ""}` : `HTTP ${status}`;
    const fields = body?.errors ? ` ${JSON.stringify(body.errors).slice(0, 600)}` : "";
    super(`${method} ${path} → ${status}: ${detail}${fields}`);
    this.status = status;
    this.code = body?.code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({
  token,
  fetchImpl = globalThis.fetch,
  reason = "KalCode community setup",
  maxRetries = 5,
}) {
  if (!token) throw new Error("A Discord bot token is required.");
  async function call(method, path, { body, query, attempt = 0 } = {}) {
    const url = `${API_BASE}${path}${query ? `?${new URLSearchParams(query)}` : ""}`;
    const headers = { Authorization: `Bot ${token}`, "User-Agent": UA };
    if (method !== "GET") headers["X-Audit-Log-Reason"] = encodeURIComponent(reason);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
      if (attempt < maxRetries) {
        await sleep(500 * 2 ** attempt);
        return call(method, path, { body, query, attempt: attempt + 1 });
      }
      throw new Error(`${method} ${path}: network error (${error.message})`);
    }
    if (res.status === 429 && attempt < maxRetries) {
      const data = await res.json().catch(() => ({}));
      const wait = Number(data.retry_after ?? res.headers.get("retry-after") ?? 1);
      await sleep(Math.ceil(wait * 1000) + 100);
      return call(method, path, { body, query, attempt: attempt + 1 });
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(750 * 2 ** attempt);
      return call(method, path, { body, query, attempt: attempt + 1 });
    }
    // Stay polite: wait out an exhausted bucket before the next call instead of hitting a 429.
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      const after = Number(res.headers.get("x-ratelimit-reset-after") ?? 0);
      if (after > 0) await sleep(Math.ceil(after * 1000));
    }
    if (res.status === 204) return null;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new DiscordError(method, path, res.status, data);
    return data;
  }
  return {
    get: (path, query) => call("GET", path, { query }),
    post: (path, body) => call("POST", path, { body }),
    patch: (path, body) => call("PATCH", path, { body }),
    put: (path, body) => call("PUT", path, { body }),
    delete: (path) => call("DELETE", path),
  };
}

/** Posts to a webhook URL (no bot token needed). `wait=true` returns the created message. */
export async function postWebhook(url, payload, { fetchImpl = globalThis.fetch } = {}) {
  const u = new URL(url);
  if (u.hostname !== "discord.com" && u.hostname !== "discordapp.com")
    throw new Error("refusing to post: not a Discord webhook URL");
  u.searchParams.set("wait", "true");
  const res = await fetchImpl(u, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // The webhook URL carries its secret; report only the status.
    throw new Error(`webhook post failed: HTTP ${res.status}${body.message ? ` (${body.message})` : ""}`);
  }
  return res.json();
}
