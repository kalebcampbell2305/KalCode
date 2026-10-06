// Offline validation of the declared server against Discord's limits and KalCode's community rules.
// Returns a list of problems (empty when the spec is valid). `kc-discord.mjs check` and the tests run it.
import { FORUM_GUIDES, MESSAGES } from "./content.mjs";
import * as S from "./server.mjs";

const PLACEHOLDER = /\{#([a-z_]+)\}/g;
const NO_CREDENTIAL_ASKS = /\b(send|share|paste|post|dm)\b[^.\n]{0,40}\b(password|api key|token|credential)s?\b/i;

function embedSize(e) {
  return (
    (e.title?.length ?? 0) +
    (e.description?.length ?? 0) +
    (e.footer?.text?.length ?? 0) +
    (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}

export function validateEmbeds(label, embeds, problems) {
  if (embeds.length > 10) problems.push(`${label}: more than 10 embeds`);
  let total = 0;
  for (const e of embeds) {
    if ((e.title ?? "").length > 256) problems.push(`${label}: title over 256 characters`);
    if ((e.description ?? "").length > 4096) problems.push(`${label}: description over 4096 characters`);
    if ((e.fields ?? []).length > 25) problems.push(`${label}: more than 25 fields`);
    for (const f of e.fields ?? []) {
      if (f.name.length > 256) problems.push(`${label}: field name over 256 characters`);
      if (f.value.length > 1024) problems.push(`${label}: field value over 1024 characters`);
    }
    total += embedSize(e);
  }
  if (total > 6000) problems.push(`${label}: embeds total ${total} characters (limit 6000)`);
}

export function validateServer() {
  const problems = [];
  const keys = new Set(Object.keys(S.CHANNELS));
  const need = (cond, msg) => {
    if (!cond) problems.push(msg);
  };

  // Roles
  const roleKeys = new Set();
  for (const r of S.ROLES) {
    need(!roleKeys.has(r.key), `duplicate role key ${r.key}`);
    roleKeys.add(r.key);
    need(Number.isInteger(r.color) && r.color >= 0 && r.color <= 0xffffff, `role ${r.name}: bad color`);
    need((r.permissions & S.P.ADMINISTRATOR) === 0n, `role ${r.name}: never grant Administrator to a community role`);
  }
  need(new Set(S.ROLES.map((r) => r.name)).size === S.ROLES.length, "role names must be unique");
  need(
    !S.ROLES.some((r) => /^(free|pro|max|max 2x)$/i.test(r.name)),
    "plan roles may only be assigned by verified entitlements; don't declare them by hand",
  );
  need((S.EVERYONE_PERMISSIONS & S.P.MENTION_EVERYONE) === 0n, "@everyone must not be able to mention @everyone");

  // Channels
  const names = new Set();
  for (const c of S.CATEGORIES) {
    need(c.name.length <= 100, `category ${c.name}: name too long`);
    for (const ch of c.channels) {
      const n = `${ch.type === "voice" ? "voice:" : ""}${ch.name}`;
      need(!names.has(n), `duplicate channel name ${ch.name}`);
      names.add(n);
      if (ch.type !== "voice") {
        need(/^[a-z0-9-]{1,100}$/.test(ch.name), `#${ch.name}: text channel names are lowercase-with-dashes`);
        need(Boolean(ch.topic), `#${ch.name}: every channel needs a description`);
        need((ch.topic ?? "").length <= (ch.type === "forum" ? 4096 : 1024), `#${ch.name}: description too long`);
      }
      if (ch.type === "forum") {
        const f = S.FORUMS[ch.forum];
        need(Boolean(f), `#${ch.name}: unknown forum ${ch.forum}`);
        need(f.tags.length <= 20, `#${ch.name}: more than 20 tags`);
        for (const t of f.tags) need(t.name.length <= 20, `#${ch.name}: tag "${t.name}" is over 20 characters`);
      }
    }
  }
  for (const k of ["support", "bugs"])
    need(/never post/i.test(S.FORUMS[k].guidelines), `${k} guidelines must warn never to post credentials`);
  for (const k of ["support", "bugs", "features"])
    need(
      !NO_CREDENTIAL_ASKS.test(S.FORUMS[k].guidelines.replace(/never post[^\n]*/gi, "")),
      `${k} guidelines must never ask for credentials`,
    );
  for (const key of [
    S.GUILD_SETTINGS.rulesChannel,
    S.GUILD_SETTINGS.publicUpdatesChannel,
    S.GUILD_SETTINGS.safetyAlertsChannel,
    S.GUILD_SETTINGS.systemChannel,
    S.INVITE.channel,
    ...S.WEBHOOKS.map((w) => w.channel),
  ])
    need(keys.has(key), `settings reference unknown channel ${key}`);
  need(S.CHANNELS[S.GUILD_SETTINGS.publicUpdatesChannel]?.staff, "the Community updates channel must be staff-only");
  need(S.CHANNELS[S.GUILD_SETTINGS.safetyAlertsChannel]?.staff, "the safety alerts channel must be staff-only");

  // AutoMod (Discord: ≤6 keyword rules, 1 each of the others, ≤10 regex ≤260 chars, message ≤150)
  const byTrigger = {};
  for (const r of S.AUTOMOD_RULES) {
    byTrigger[r.trigger] = (byTrigger[r.trigger] ?? 0) + 1;
    need((r.regex ?? []).length <= 10, `AutoMod ${r.name}: more than 10 regex patterns`);
    for (const re of r.regex ?? []) {
      need(re.length <= 260, `AutoMod ${r.name}: regex over 260 characters`);
      need(!/\(\?[=!<]/.test(re), `AutoMod ${r.name}: look-around isn't supported by Discord (Rust regex)`);
      try {
        new RegExp(re);
      } catch (e) {
        problems.push(`AutoMod ${r.name}: regex doesn't compile: ${e.message}`);
      }
    }
    for (const k of r.keywords ?? []) need(k.length <= 60, `AutoMod ${r.name}: keyword "${k}" over 60 characters`);
    need((r.block ?? "").length <= 150, `AutoMod ${r.name}: block message over 150 characters`);
  }
  need((byTrigger.keyword ?? 0) <= 6, "at most 6 keyword AutoMod rules");
  for (const t of ["spam", "mention_spam", "keyword_preset", "member_profile"])
    need((byTrigger[t] ?? 0) <= 1, `at most one ${t} AutoMod rule`);

  // Onboarding (Discord: ≥7 default channels, ≥5 of them where @everyone can send messages)
  const defaults = S.ONBOARDING.defaultChannels;
  for (const k of defaults) need(keys.has(k), `onboarding default channel ${k} is unknown`);
  need(defaults.length >= 7, "onboarding needs at least 7 default channels");
  const sendable = defaults.filter((k) => {
    const c = S.CHANNELS[k];
    return c && !c.readOnly && !c.staff && c.type !== "voice";
  });
  need(sendable.length >= 5, "onboarding needs at least 5 default channels members can post in");
  for (const p of S.ONBOARDING.prompts) {
    need(p.title.length <= 100, `onboarding prompt "${p.title}" too long`);
    for (const o of p.options) {
      need((o.channels?.length ?? 0) + (o.roles?.length ?? 0) > 0, `onboarding option "${o.title}" assigns nothing`);
      need(o.title.length <= 50, `onboarding option "${o.title}" title too long`);
      need((o.description ?? "").length <= 100, `onboarding option "${o.title}" description too long`);
      for (const k of o.channels ?? [])
        need(keys.has(k) && !S.CHANNELS[k].staff, `onboarding option "${o.title}" → bad channel ${k}`);
      for (const k of o.roles ?? [])
        need(roleKeys.has(k) && !S.STAFF_ROLES.includes(k), `onboarding option "${o.title}" → bad role ${k}`);
    }
  }
  need(S.WELCOME_SCREEN.channels.length <= 5, "the welcome screen shows at most 5 channels");
  need(S.WELCOME_SCREEN.description.length <= 140, "welcome screen description over 140 characters");
  for (const c of S.WELCOME_SCREEN.channels) {
    need(keys.has(c.channel), `welcome screen channel ${c.channel} is unknown`);
    need(c.description.length <= 42, `welcome screen "${c.description}" over 42 characters`);
  }

  // Content
  for (const m of [...MESSAGES, ...FORUM_GUIDES]) {
    need(keys.has(m.channel), `message ${m.key}: unknown channel ${m.channel}`);
    validateEmbeds(`message ${m.key}`, m.embeds, problems);
    for (const [, k] of JSON.stringify(m.embeds).matchAll(PLACEHOLDER))
      need(keys.has(k), `message ${m.key}: unknown placeholder {#${k}}`);
    need(
      !NO_CREDENTIAL_ASKS.test(JSON.stringify(m.embeds).replace(/never (post|share)[^"\\]*/gi, "")),
      `message ${m.key} asks for credentials`,
    );
  }
  for (const g of FORUM_GUIDES) need(g.title.length <= 100, `guide ${g.key}: thread title too long`);
  return problems;
}
