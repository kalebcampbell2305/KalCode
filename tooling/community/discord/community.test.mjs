// Tests for the KalCode Discord tooling: the declared server, AutoMod patterns, the changelog and roadmap
// renderers, secret handling, and `apply` end to end against an in-memory Discord.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyServer, automodPayload, memberPermissions, snowflake, stable } from "./apply.mjs";
import {
  changelogPost,
  changelogTitle,
  classify,
  extractBullets,
  listReleases,
  readRelease,
  summarize,
  withoutUnavailable,
} from "./changelog.mjs";
import { MESSAGES, resolveMentions } from "./content.mjs";
import { createClient, DiscordError } from "./discord-api.mjs";
import { createFakeDiscord, FAKE_TOKEN } from "./fake-discord.mjs";
import { loadCatalog, roadmapMessages, roadmapSections } from "./roadmap.mjs";
import { applicationIdFromToken, loadToken, redact } from "./secrets.mjs";
import * as S from "./server.mjs";
import { validateServer } from "./validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const plansPath = join(repoRoot, "packages", "protocol", "src", "plans.ts");
const matchesAny = (patterns, text) => patterns.some((p) => new RegExp(p).test(text));

describe("declared server", () => {
  it("passes validation", () => {
    assert.deepEqual(validateServer(), []);
  });

  it("has the requested structure and nothing extra", () => {
    assert.deepEqual(
      S.CATEGORIES.map((c) => c.name),
      ["START HERE", "KALCODE", "BUILD WITH KALCODE", "COMMUNITY", "VOICE", "STAFF"],
    );
    for (const k of ["support", "bugs", "features"]) assert.equal(S.CHANNELS[k].type, "forum");
    for (const k of ["welcome", "rules", "announcements", "changelog", "roadmap"]) assert.ok(S.CHANNELS[k].readOnly);
    for (const k of ["staff", "moderation", "reports", "notes"]) assert.ok(S.CHANNELS[k].staff);
    assert.ok(
      Object.keys(S.CHANNELS).length <= 25,
      "keep the server small; add channels only when activity justifies it",
    );
  });

  it("gives community roles no admin and @everyone no mass mentions", () => {
    for (const r of S.ROLES) assert.equal(r.permissions & S.P.ADMINISTRATOR, 0n, r.name);
    assert.equal(S.EVERYONE_PERMISSIONS & S.P.MENTION_EVERYONE, 0n);
    assert.equal(S.EVERYONE_PERMISSIONS & S.P.MANAGE_WEBHOOKS, 0n);
  });

  it("bug and support templates warn never to post credentials", () => {
    for (const k of ["support", "bugs"])
      assert.match(S.FORUMS[k].guidelines, /never post passwords, api keys, provider tokens/i);
    assert.match(
      S.FORUMS.features.guidelines,
      /WHAT DO YOU WANT\?[\s\S]*WHY WOULD IT HELP\?[\s\S]*HOW WOULD YOU EXPECT IT TO WORK\?/,
    );
    assert.match(
      S.FORUMS.bugs.guidelines,
      /WHAT HAPPENED\?[\s\S]*WHAT DID YOU EXPECT\?[\s\S]*KALCODE VERSION[\s\S]*WINDOWS \/ MAC[\s\S]*PROVIDER[\s\S]*STEPS TO REPRODUCE[\s\S]*SCREENSHOT/,
    );
  });

  it("resolves every channel placeholder and rejects unknown ones", () => {
    const ids = Object.fromEntries(Object.keys(S.CHANNELS).map((k, i) => [k, String(1000 + i)]));
    for (const m of MESSAGES)
      assert.doesNotMatch(JSON.stringify(resolveMentions(JSON.stringify(m.embeds), ids)), /\{#/);
    assert.throws(() => resolveMentions("see {#nope}", ids), /unknown channel placeholder/);
  });
});

describe("AutoMod patterns", () => {
  // Fake, obviously-invalid credentials, assembled at runtime so no key-shaped string is committed.
  const fakes = {
    anthropic: `sk-ant-${"a1".repeat(20)}`,
    openai: `sk-proj-${"Ab3".repeat(16)}`,
    github: `ghp_${"x9".repeat(20)}`,
    githubPat: `github_pat_${"y8".repeat(35)}`,
    slack: `xoxb-${"1".repeat(12)}-abc`,
    aws: `AKIA${"Q".repeat(16)}`,
    google: `AIza${"z".repeat(35)}`,
    stripe: `sk_live_${"0".repeat(24)}`,
    pem: "-----BEGIN RSA PRIVATE KEY-----",
    discord: `M${"a".repeat(25)}.${"b".repeat(6)}.${"c".repeat(30)}`,
  };

  it("blocks every kind of secret", () => {
    for (const [kind, value] of Object.entries(fakes))
      assert.ok(matchesAny(S.SECRET_PATTERNS, `here is my key ${value} thanks`), kind);
  });

  it("leaves ordinary engineering talk alone", () => {
    for (const text of [
      "risk-assessment-for-the-new-deployment-plan-before-the-release-goes-out",
      "Where do I put my API key? In Settings › Providers, never in chat.",
      "My token expired, how do I sign in again?",
      "ask-the-team-about-the-oauth-redirect-handling-in-the-desktop-app",
      "https://github.com/kalebcampbell2305/KalCode/pull/245",
      "const session = await store.resolve(req);",
    ])
      assert.ok(!matchesAny(S.SECRET_PATTERNS, text), text);
  });

  it("catches fake Discord gift domains but not the real ones", () => {
    for (const bad of ["claim at discord-gift.ru/abc", "dlscord.com/free", "discordnitro.xyz/claim", "disc0rd.gg/x"])
      assert.ok(matchesAny(S.SCAM_PATTERNS, bad), bad);
    for (const ok of [
      "https://discord.gift/AbCdEf",
      "https://discord.com/channels/1/2",
      "https://discord.gg/KalCode",
      "cdn.discordapp.com/x.png",
    ])
      assert.ok(!matchesAny(S.SCAM_PATTERNS, ok), ok);
  });

  it("builds valid Discord AutoMod payloads", () => {
    const staff = ["1", "2", "3"];
    const secrets = automodPayload(
      S.AUTOMOD_RULES.find((r) => r.name === "Protect secrets and tokens"),
      { alertChannel: "99", staffRoleIds: staff },
    );
    assert.equal(secrets.trigger_type, 1);
    assert.deepEqual(secrets.exempt_roles, [], "secrets are blocked for everyone, staff included");
    assert.deepEqual(
      secrets.actions.map((a) => a.type),
      [1, 2],
    );
    const mention = automodPayload(
      S.AUTOMOD_RULES.find((r) => r.trigger === "mention_spam"),
      { alertChannel: "99", staffRoleIds: staff },
    );
    assert.deepEqual(
      mention.actions.map((a) => a.type),
      [1, 2, 3],
    );
    assert.equal(mention.trigger_metadata.mention_raid_protection_enabled, true);
    const profile = automodPayload(
      S.AUTOMOD_RULES.find((r) => r.trigger === "member_profile"),
      { alertChannel: "99", staffRoleIds: staff },
    );
    assert.equal(profile.event_type, 2);
    assert.deepEqual(profile.actions, [{ type: 4, metadata: {} }]);
    assert.deepEqual(profile.exempt_roles, staff);
  });
});

describe("changelog", () => {
  const releases = join(repoRoot, "docs", "releases");

  it("turns release notes into NEW and FIXED one-liners", () => {
    const post = changelogPost("0.1.9+1738", readRelease(repoRoot, "0.1.9+1738"));
    const e = post.embeds[0];
    assert.equal(e.title, "KalCode 0.1.9 · build 1738");
    assert.match(e.description, /\*\*NEW\*\*\n• One agent state everywhere/);
    assert.match(e.description, /\*\*FIXED\*\*/);
    assert.match(e.description, /kalcoded\.com\/download/);
    assert.deepEqual(post.allowed_mentions, { parse: [] });
  });

  it("stays inside Discord's limits for every release", () => {
    for (const id of listReleases(releases)) {
      const e = changelogPost(id, readRelease(repoRoot, id)).embeds[0];
      assert.ok(e.description.length <= 4096, id);
      assert.ok(e.title.length <= 256, id);
    }
  });

  it("never presents a publicly unavailable provider as working", () => {
    assert.equal(
      withoutUnavailable("Cursor joins Claude Code, Codex and Gemini CLI as a native coding provider"),
      "Cursor joins Claude Code and Codex as a native coding provider",
    );
    assert.equal(withoutUnavailable("Codex and Gemini CLI work as they do in your terminal"), null);
    for (const id of listReleases(releases).filter((r) => r.startsWith("0.1.9")))
      assert.doesNotMatch(changelogPost(id, readRelease(repoRoot, id)).embeds[0].description, /Gemini/, id);
  });

  it("summarizes bold leads and first sentences", () => {
    assert.equal(summarize("**Faster terminals.** Terminal output is batched."), "Faster terminals");
    assert.equal(summarize("Connect workspace tools. More detail here."), "Connect workspace tools");
    assert.equal(classify("Tool calls are no longer blocked when KalCode is busy"), "fixed");
    assert.equal(classify("Workspace favorites and global pins"), "new");
    assert.deepEqual(extractBullets("## New in this build\n\n- **A.** one\n  more\n- B\n\n## Downloads\n- x"), [
      "**A.** one more",
      "B",
    ]);
  });

  it("orders releases by version then build", () => {
    const ids = listReleases(releases);
    assert.ok(ids.indexOf("0.1.9+1340") < ids.indexOf("0.1.9+1738"));
    assert.ok(ids.indexOf("0.1.8+944") < ids.indexOf("0.1.9+1038"));
    assert.equal(changelogTitle("0.1.9"), "KalCode 0.1.9");
  });
});

describe("roadmap", () => {
  it("mirrors the plan catalog and fits Discord's limits", async () => {
    const groups = await loadCatalog(plansPath);
    const msgs = roadmapMessages(groups);
    const text = JSON.stringify(msgs);
    for (const g of groups)
      for (const f of g.features) assert.ok(text.includes(f.label.replace(/"/g, '\\"')), `${f.id} is listed`);
    for (const m of msgs) {
      assert.ok(m.embeds.length <= 10);
      const total = m.embeds.reduce((n, e) => n + e.title.length + e.description.length, 0);
      assert.ok(total <= 6000, `${m.key}: ${total}`);
    }
    const available = roadmapSections(groups).find((s) => s.key === "available");
    const availableLabels = new Set(available.groups.flatMap((g) => g.items));
    for (const g of groups)
      for (const f of g.features)
        if (f.status !== "available")
          assert.ok(!availableLabels.has(f.label), `${f.id} must not be listed as available`);
  });

  it("shows IN DEVELOPMENT only for ids the owner names", async () => {
    const groups = await loadCatalog(plansPath);
    assert.equal(
      roadmapSections(groups, []).some((s) => s.key === "in_development"),
      false,
    );
    const soon = groups.flatMap((g) => g.features).find((f) => f.status === "coming_soon");
    const sections = roadmapSections(groups, [soon.id]);
    assert.deepEqual(
      sections.find((s) => s.key === "in_development").groups.flatMap((g) => g.items),
      [soon.label],
    );
    assert.ok(
      !sections
        .find((s) => s.key === "coming_soon")
        .groups.flatMap((g) => g.items)
        .includes(soon.label),
    );
    assert.throws(() => roadmapSections(groups, ["not-a-feature"]), /unknown feature id/);
  });
});

describe("secrets", () => {
  it("loads the token from the environment or the token file, and validates its shape", () => {
    assert.equal(loadToken({ env: { DISCORD_BOT_TOKEN: FAKE_TOKEN }, file: "/nope" }), FAKE_TOKEN);
    assert.equal(loadToken({ env: { DISCORD_BOT_TOKEN: `Bot ${FAKE_TOKEN}` }, file: "/nope" }), FAKE_TOKEN);
    const dir = mkdtempSync(join(tmpdir(), "kc-discord-"));
    writeFileSync(join(dir, "bot-token"), `${FAKE_TOKEN}\n`);
    assert.equal(loadToken({ env: {}, file: join(dir, "bot-token") }), FAKE_TOKEN);
    assert.equal(loadToken({ env: {}, file: join(dir, "missing") }), null);
    assert.throws(
      () => loadToken({ env: { DISCORD_BOT_TOKEN: "not-a-token" }, file: "/nope" }),
      /doesn't look like a bot token/,
    );
    assert.equal(applicationIdFromToken(FAKE_TOKEN), "123456789012345678");
  });

  it("redacts tokens and webhook secrets from anything printed", () => {
    const hook = "https://discord.com/api/webhooks/123456/AbCdEf_secret-Value";
    const text = redact(`token ${FAKE_TOKEN} and ${hook} and Authorization: Bot ${FAKE_TOKEN}`);
    assert.doesNotMatch(text, new RegExp(FAKE_TOKEN.split(".")[2]));
    assert.doesNotMatch(text, /AbCdEf_secret/);
    assert.match(text, /webhooks\/123456\/\[redacted\]/);
  });

  it("never puts the token in an API error", async () => {
    const fake = createFakeDiscord();
    const api = createClient({ token: FAKE_TOKEN, fetchImpl: fake.fetchImpl });
    await assert.rejects(api.get("/nowhere"), (e) => e instanceof DiscordError && !e.message.includes(FAKE_TOKEN));
  });
});

describe("apply", () => {
  const run = async (fake, opts = {}) => {
    const api = createClient({ token: FAKE_TOKEN, fetchImpl: fake.fetchImpl });
    const logs = [];
    const hooks = {};
    const report = await applyServer({
      api,
      repoRoot,
      log: (l) => logs.push(l),
      plansGroups: await loadCatalog(plansPath),
      changelogIds: ["0.1.9+1658", "0.1.9+1738"],
      state: opts.state ?? {},
      webhookStore: { get: () => hooks, set: (m) => Object.assign(hooks, m) },
      ...opts,
    });
    return { report, logs, hooks };
  };

  it("builds the whole server on a fresh Discord server", async () => {
    const fake = createFakeDiscord();
    const { report, hooks } = await run(fake);
    const s = fake.state;
    assert.ok(s.guild.features.includes("COMMUNITY"), "Community is enabled");
    assert.equal(s.guild.verification_level, 2);
    assert.equal(s.guild.explicit_content_filter, 2);
    const byName = (n) => s.channels.find((c) => c.name === n);
    assert.equal(byName("help-and-support").type, 15);
    assert.equal(byName("bug-reports").type, 15);
    assert.equal(byName("announcements").type, 5);
    assert.equal(byName("changelog").type, 5);
    assert.equal(s.guild.rules_channel_id, byName("rules").id);
    assert.equal(s.guild.public_updates_channel_id, byName("moderation").id);
    // the existing #general and General voice channel were adopted, not duplicated
    assert.equal(s.channels.filter((c) => c.name === "general").length, 1);
    assert.equal(byName("general").id, "12");
    assert.equal(byName("General").id, "13");
    assert.equal(byName("General").parent_id, byName("VOICE").id);
    // Discord's empty default categories are gone
    assert.equal(byName("Text Channels"), undefined);
    assert.equal(byName("Voice Channels"), undefined);
    // staff is private, announcements are read-only
    const staffCat = byName("STAFF");
    assert.ok(staffCat.permission_overwrites.some((o) => o.id === s.guild.id && BigInt(o.deny) & S.P.VIEW_CHANNEL));
    assert.ok(
      byName("announcements").permission_overwrites.some(
        (o) => o.id === s.guild.id && BigInt(o.deny) & S.P.SEND_MESSAGES,
      ),
    );
    // roles, in order, beneath the bot; the owner wears Owner
    const ours = S.ROLES.map((r) => s.roles.find((x) => x.name === r.name));
    assert.ok(ours.every((r, i) => i === 0 || ours[i - 1].position > r.position));
    assert.ok(ours[0].position < s.roles.find((r) => r.id === "500").position);
    assert.ok(s.members[S.OWNER_USER_ID].roles.includes(ours[0].id));
    // AutoMod, onboarding, welcome screen, guides, messages, invite, webhooks
    assert.equal(s.automod.length, S.AUTOMOD_RULES.length);
    assert.equal(s.onboarding.enabled, true);
    assert.equal(s.onboarding.prompts.length, 2);
    assert.equal(s.welcome.welcome_channels.length, 5);
    assert.equal(s.threads.length, 3);
    assert.ok(s.threads.every((t) => t.flags & 2 && t.thread_metadata.locked));
    const changelog = s.messages[byName("changelog").id].map((m) => m.embeds[0].title);
    assert.deepEqual(changelog, ["KalCode 0.1.9 · build 1658", "KalCode 0.1.9 · build 1738"]);
    assert.ok(s.messages[byName("roadmap").id].length >= 3);
    assert.equal(report.invite, "https://discord.gg/KalCodeHQ");
    assert.match(hooks.changelog, /^https:\/\/discord\.com\/api\/webhooks\/\d+\/wh/);
    // resolved mentions, never placeholders
    assert.doesNotMatch(JSON.stringify(s.messages), /\{#[a-z]/);
  });

  it("is idempotent: a second run creates nothing and changes nothing", async () => {
    const fake = createFakeDiscord();
    const state = {};
    await run(fake, { state });
    const before = fake.state.requests.length;
    const { report } = await run(fake, { state });
    const writes = fake.state.requests.slice(before).filter((r) => r.method !== "GET");
    assert.deepEqual(report.created, []);
    assert.deepEqual(report.updated, [], `unexpected updates: ${report.updated.join("; ")}`);
    assert.deepEqual(writes, []);
  });

  it("plans without writing anything", async () => {
    const fake = createFakeDiscord();
    const { report } = await run(fake, { dryRun: true });
    assert.ok(report.created.length > 20);
    assert.deepEqual(
      fake.state.requests.filter((r) => r.method !== "GET"),
      [],
    );
  });

  it("never deletes channels it doesn't own", async () => {
    const fake = createFakeDiscord();
    fake.state.channels.push({ id: "77", name: "memes", type: 0, parent_id: "10", permission_overwrites: [] });
    const { report } = await run(fake);
    assert.ok(fake.state.channels.some((c) => c.id === "77"));
    assert.ok(
      fake.state.channels.some((c) => c.name === "Text Channels"),
      "a default category with other channels stays",
    );
    assert.ok(report.warnings.some((w) => w.includes("memes")));
  });

  it("refuses to run without Administrator, with a clear next step", async () => {
    const fake = createFakeDiscord();
    fake.state.roles.find((r) => r.id === "500").permissions = String(S.P.SEND_MESSAGES);
    await assert.rejects(run(fake), /needs the Administrator permission/);
  });

  it("keeps the token out of every log line and audit reason", async () => {
    const fake = createFakeDiscord();
    const { logs } = await run(fake);
    assert.ok(!logs.join("\n").includes(FAKE_TOKEN));
    for (const r of fake.state.requests.filter((x) => x.method !== "GET"))
      assert.ok(!String(r.headers["X-Audit-Log-Reason"]).includes(FAKE_TOKEN));
  });
});

describe("helpers", () => {
  it("computes member permissions and stable keys", () => {
    const roles = [
      { id: "g", permissions: "1024" },
      { id: "a", permissions: "2048" },
    ];
    assert.equal(memberPermissions(["a"], roles, "g"), 3072n);
    assert.equal(stable({ b: 1, a: [2n] }), stable({ a: [2n], b: 1 }));
    assert.match(snowflake(1, 1759700000000), /^\d{17,20}$/);
  });
});
