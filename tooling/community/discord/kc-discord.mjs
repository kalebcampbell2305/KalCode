#!/usr/bin/env node
// The KalCode Discord, as code. Usage (from the repo root):
//   node tooling/community/discord/kc-discord.mjs check                validate the declared server (offline)
//   node tooling/community/discord/kc-discord.mjs plan                 show the server; with a token, a full dry run
//   node tooling/community/discord/kc-discord.mjs apply                make the live server match (needs the bot token)
//   node tooling/community/discord/kc-discord.mjs invite-url [app-id]  the link that adds the bot to the server
//   node tooling/community/discord/kc-discord.mjs changelog <id> [--post]   preview / post one release (e.g. 0.1.9+1738)
//   node tooling/community/discord/kc-discord.mjs roadmap              preview #roadmap
//   node tooling/community/discord/kc-discord.mjs badges               render the badge artwork
//   node tooling/community/discord/kc-discord.mjs recognize [--dry-run]  grant earned badges and post shout-outs
//   node tooling/community/discord/kc-discord.mjs schedule             run recognize every 15 minutes (Windows)
// Secrets: see secrets.mjs. The token is read from DISCORD_BOT_TOKEN or ~/.kalcode/discord/bot-token and is never printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyServer } from "./apply.mjs";
import { changelogPost, changelogTitle, listReleases, parseReleaseId, readRelease } from "./changelog.mjs";
import { resolvePayload } from "./content.mjs";
import { createClient, postWebhook } from "./discord-api.mjs";
import { loadCatalog, roadmapMessages } from "./roadmap.mjs";
import {
  applicationIdFromToken,
  loadToken,
  loadWebhooks,
  redact,
  SECRET_DIR,
  saveWebhooks,
  TOKEN_FILE,
  WEBHOOK_FILE,
} from "./secrets.mjs";
import * as S from "./server.mjs";
import { validateServer } from "./validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
// KC_PLANS points at another checkout of the plan catalog (e.g. an unmerged catalog fix).
const plansPath = process.env.KC_PLANS ?? join(repoRoot, "packages", "protocol", "src", "plans.ts");
const STATE_FILE = join(SECRET_DIR, "state.json");
const SEED_COUNT = 9;

const out = (s = "") => console.log(redact(s));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const cmd = args.find((a) => !a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--")).slice(1);

/** The latest version's newest releases, oldest first (what #changelog starts with). */
function seedReleases(count = SEED_COUNT) {
  const all = listReleases(join(repoRoot, "docs", "releases"));
  const latest = parseReleaseId(all[all.length - 1]).version;
  return all.filter((id) => parseReleaseId(id).version === latest && parseReleaseId(id).build).slice(-count);
}

function printTree() {
  out("KalCode Discord (declared)\n");
  out("Roles (top → bottom):");
  for (const r of S.ROLES) out(`  ${r.name}${r.color ? `  #${r.color.toString(16).padStart(6, "0")}` : ""}`);
  out("");
  for (const c of S.CATEGORIES) {
    out(`${c.name}${c.staff ? "  (private: staff only)" : ""}`);
    for (const ch of c.channels) {
      const kind = { text: "#", announcement: "📣", forum: "🗂", voice: "🔊" }[ch.type];
      out(`  ${kind} ${ch.name}${ch.readOnly ? "  (read-only)" : ""}${ch.type === "forum" ? "  (forum)" : ""}`);
    }
  }
  out("\nAutoMod:");
  for (const r of S.AUTOMOD_RULES) out(`  • ${r.name}`);
  out(`\nOnboarding: ${S.ONBOARDING.prompts.map((p) => `"${p.title}"`).join(", ")}`);
}

function bail(message) {
  console.error(redact(message));
  process.exit(1);
}

async function main() {
  switch (cmd) {
    case "check": {
      const problems = validateServer();
      if (problems.length) bail(`Server spec has problems:\n${problems.map((p) => `  • ${p}`).join("\n")}`);
      out("Server spec OK.");
      return;
    }
    case "plan":
    case "apply": {
      const problems = validateServer();
      if (problems.length) bail(`Server spec has problems:\n${problems.map((p) => `  • ${p}`).join("\n")}`);
      const token = loadToken();
      if (!token) {
        printTree();
        if (cmd === "apply")
          bail(`\nNo bot token. Put it in ${TOKEN_FILE} (one line) or DISCORD_BOT_TOKEN, then run apply again.`);
        out(
          `\nNo bot token found (${TOKEN_FILE}), so this is the declared plan only. Add the token for a live dry run.`,
        );
        return;
      }
      const dryRun = cmd === "plan";
      const api = createClient({ token, reason: "KalCode community setup (kc-discord apply)" });
      const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
      const report = await applyServer({
        api,
        repoRoot,
        dryRun,
        log: out,
        plansGroups: await loadCatalog(plansPath),
        changelogIds: seedReleases(),
        state,
        webhookStore: { get: () => loadWebhooks(), set: (m) => saveWebhooks(m) },
      });
      if (!dryRun) {
        mkdirSync(SECRET_DIR, { recursive: true });
        writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      }
      out(
        `\n${dryRun ? "Plan" : "Applied"}: ${report.created.length} to create, ${report.updated.length} to update, ${report.unchanged.length} unchanged.`,
      );
      for (const s of report.skipped) out(`  skipped: ${s}`);
      for (const w of report.warnings) out(`  note: ${w}`);
      if (report.invite) out(`\nPermanent invite: ${report.invite}`);
      if (!dryRun) out(`Release webhooks saved to ${WEBHOOK_FILE} (kept private).`);
      return;
    }
    case "invite-url": {
      const token = loadToken();
      const appId = positional[0] ?? (token ? applicationIdFromToken(token) : null);
      if (!appId) bail("Pass the application id: kc-discord.mjs invite-url <application-id>");
      // Administrator is needed once, for setup (Community, onboarding, AutoMod). It can be lowered after.
      out(
        `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=8&guild_id=${S.GUILD_ID}&disable_guild_select=true`,
      );
      return;
    }
    case "changelog": {
      const id = positional[0] ?? seedReleases(1)[0];
      const post = changelogPost(id, readRelease(repoRoot, id));
      if (!flag("post")) {
        out(`${changelogTitle(id)}\n`);
        out(post.embeds[0].description);
        out("\n(preview only; add --post to publish to #changelog)");
        return;
      }
      const { _meta, ...payload } = post;
      const token = loadToken();
      if (token) {
        // With the bot: refuse duplicates by checking the channel first.
        const api = createClient({ token, reason: `KalCode changelog ${id}` });
        const channels = await api.get(`/guilds/${S.GUILD_ID}/channels`);
        const ch = channels.find((c) => c.name === S.CHANNELS.changelog.name);
        if (!ch) bail("No #changelog channel yet. Run apply first.");
        const recent = await api.get(`/channels/${ch.id}/messages`, { limit: "50" });
        if (recent.some((m) => m.embeds?.[0]?.title === changelogTitle(id))) {
          out(`${changelogTitle(id)} is already in #changelog.`);
          return;
        }
        const msg = await api.post(`/channels/${ch.id}/messages`, resolvePayload(payload, {}));
        await api.post(`/channels/${ch.id}/messages/${msg.id}/crosspost`).catch(() => {});
        out(`Posted ${changelogTitle(id)} to #changelog.`);
        return;
      }
      const hooks = loadWebhooks();
      if (!hooks.changelog) bail(`No bot token and no changelog webhook in ${WEBHOOK_FILE}. Run apply first.`);
      await postWebhook(hooks.changelog, payload);
      out(`Posted ${changelogTitle(id)} to #changelog (webhook).`);
      return;
    }
    case "roadmap": {
      const messages = roadmapMessages(await loadCatalog(plansPath));
      for (const m of messages) for (const e of m.embeds) out(`── ${e.title} ──\n${e.description}\n`);
      return;
    }
    case "badges": {
      const { writeBadges } = await import("./badges.mjs");
      const files = writeBadges(join(repoRoot, "assets", "branding", "discord", "badges"));
      out(`Rendered ${files.length} badge images into assets/branding/discord/badges/.`);
      return;
    }
    case "recognize": {
      const token = loadToken();
      if (!token) bail(`No bot token in ${TOKEN_FILE}.`);
      const { recognize } = await import("./recognize.mjs");
      const ledgerFile = join(SECRET_DIR, "recognition.json");
      const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : {};
      const dryRun = flag("dry-run");
      const report = await recognize({
        api: createClient({ token, reason: "KalCode badges (kc-discord recognize)" }),
        ledger,
        dryRun,
        log: (l) => out(`${new Date().toISOString()} ${l}`),
      });
      if (!dryRun) {
        mkdirSync(SECRET_DIR, { recursive: true });
        writeFileSync(ledgerFile, `${JSON.stringify(ledger)}\n`, "utf8");
      }
      out(
        `${new Date().toISOString()} ${dryRun ? "Plan" : "Done"}: ${report.granted.length} badge(s) granted, ${report.shouted.length} shout-out(s).`,
      );
      for (const w of report.warnings) out(`  note: ${w}`);
      return;
    }
    case "schedule": {
      // Runs `recognize` every 15 minutes, hidden, logging to ~/.kalcode/discord/recognize.log.
      if (process.platform !== "win32")
        bail(
          "On macOS, add a launchd agent that runs `node <repo>/tooling/community/discord/kc-discord.mjs recognize` every 15 minutes.",
        );
      const { execFileSync } = await import("node:child_process");
      mkdirSync(SECRET_DIR, { recursive: true });
      const script = fileURLToPath(import.meta.url);
      const logFile = join(SECRET_DIR, "recognize.log");
      const vbs = join(SECRET_DIR, "recognize-hidden.vbs");
      // `cmd /s /c "<command>"` strips exactly one outer pair of quotes, so quoted paths with spaces
      // (C:\Program Files\nodejs) survive. Chr(34) keeps the VBScript readable.
      const quoted = (s) => `q & "${s}" & q`;
      writeFileSync(
        vbs,
        [
          "' Runs KalCode Discord badge recognition without a console window (created by kc-discord.mjs schedule).",
          'Set sh = CreateObject("WScript.Shell")',
          "q = Chr(34)",
          `sh.Run "cmd /s /c " & q & ${quoted(process.execPath)} & " " & ${quoted(script)} & " recognize >> " & ${quoted(logFile)} & " 2>&1" & q, 0, False`,
          "",
        ].join("\r\n"),
        "utf8",
      );
      const task = "KalCode Discord badges";
      execFileSync(
        "schtasks",
        ["/Create", "/F", "/SC", "MINUTE", "/MO", "15", "/TN", task, "/TR", `wscript.exe "${vbs}"`],
        { stdio: "ignore", windowsHide: true },
      );
      out(`Scheduled "${task}" every 15 minutes. Log: ${logFile}. Remove with: schtasks /Delete /TN "${task}" /F`);
      return;
    }
    default:
      out(
        readFileSync(fileURLToPath(import.meta.url), "utf8")
          .split("\n")
          .slice(1, 14)
          .join("\n")
          .replace(/^\/\/ ?/gm, ""),
      );
  }
}

main().catch((error) => bail(`kc-discord: ${error.message}`));
