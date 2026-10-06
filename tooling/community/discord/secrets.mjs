// Secrets for the KalCode Discord tooling live outside the repository, in the user's profile:
//   ~/.kalcode/discord/bot-token       the bot token (one line), or DISCORD_BOT_TOKEN in the environment
//   ~/.kalcode/discord/webhooks.json   webhook URLs created by `apply` (they embed their own secret)
// Nothing here ever prints a secret; `redact` scrubs anything token-shaped from text that is printed.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SECRET_DIR = join(homedir(), ".kalcode", "discord");
export const TOKEN_FILE = join(SECRET_DIR, "bot-token");
export const WEBHOOK_FILE = join(SECRET_DIR, "webhooks.json");

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;

/** The bot token from the environment or the token file, or null. Never logged. */
export function loadToken({ env = process.env, file = TOKEN_FILE } = {}) {
  const raw = env.DISCORD_BOT_TOKEN?.trim() || (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
  if (!raw) return null;
  const token = raw.replace(/^Bot\s+/i, "");
  if (!TOKEN_SHAPE.test(token))
    throw new Error("The Discord bot token doesn't look like a bot token (expected three dot-separated parts).");
  return token;
}

/** The application id is the first token segment, base64-encoded. */
export function applicationIdFromToken(token) {
  const id = Buffer.from(token.split(".")[0], "base64").toString("utf8");
  return /^\d{15,25}$/.test(id) ? id : null;
}

export function loadWebhooks(file = WEBHOOK_FILE) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

export function saveWebhooks(map, file = WEBHOOK_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: the file sits in the user's own profile directory, which is already private to them.
  }
}

/** Removes bot tokens and webhook secrets from text before it is printed. */
export function redact(text) {
  return String(text)
    .replace(/(discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)[A-Za-z0-9_-]+/g, "$1[redacted]")
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g, "[redacted-token]")
    .replace(/Bot\s+[A-Za-z0-9._-]+/g, "Bot [redacted]");
}
