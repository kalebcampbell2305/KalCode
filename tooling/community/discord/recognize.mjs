// Badge recognition: who earned which badge, decided from what members actually did. Additive only (a
// badge is never removed automatically), idempotent (a member who has the role is skipped), and quiet
// by design (capped shout-outs; Early Adopter never shouts). Run it on a schedule:
//   node tooling/community/discord/kc-discord.mjs recognize [--dry-run]
// Activity is read incrementally: each run only fetches messages after the last one it saw, and keeps
// a small local ledger (~/.kalcode/discord/recognition.json: message cursors, active days per member,
// who replied in which forum post, which badges were already announced). No message content is stored.
import { badgeEmojiName, resolvePayload } from "./content.mjs";
import * as S from "./server.mjs";

const DAY_MS = 86_400_000;
const COUNTED_TYPES = new Set([0, 19]); // default messages and replies (not joins, pins or system notices)
const MAX_PAGES = 50; // per channel per run (5,000 messages): catches up over several runs if needed
const big = (id) => BigInt(id);

// ── Decisions (pure) ───────────────────────────────────────────────────────────────────────────

/**
 * Every badge a member has earned but doesn't hold yet.
 * @param {object} input
 *   members: [{ id, bot, joinedAt (ISO), roles: [roleId] }]
 *   activeDays: { userId: ["YYYY-MM-DD"] }
 *   threads: [{ id, forum (spec key), ownerId, title, tags: [name], authors: [userId] }]
 *   featured: [{ messageId, authorId }]   (showcase posts a staff member starred)
 *   roleIds: { roleKey: roleId }, now: Date
 * @returns [{ userId, badge, reason: { title?, count? } }]
 */
export function decideAwards({ members, activeDays, threads, featured, roleIds, now = new Date(), badges = S.BADGES }) {
  const awards = [];
  const byId = new Map(members.filter((m) => !m.bot).map((m) => [m.id, m]));
  const staffRoleIds = new Set(S.STAFF_ROLES.map((k) => roleIds[k]).filter(Boolean));
  const isStaff = (m) => m.roles.some((r) => staffRoleIds.has(r));
  for (const badge of badges) {
    const roleId = roleIds[badge.role];
    if (!roleId) continue;
    const lacks = (m) => m && !m.roles.includes(roleId);
    const give = (userId, reason = {}) => {
      const m = byId.get(userId);
      if (lacks(m) && !awards.some((a) => a.userId === userId && a.badge.key === badge.key))
        awards.push({ userId, badge, reason });
    };
    const e = badge.earn;
    if (e.kind === "activity") {
      for (const m of byId.values()) {
        const days = new Set(activeDays[m.id] ?? []).size;
        const memberFor = m.joinedAt ? (now - new Date(m.joinedAt)) / DAY_MS : 0;
        if (days >= e.activeDays && (!e.memberDays || memberFor >= e.memberDays)) give(m.id, { count: days });
      }
    } else if (e.kind === "forum-tag") {
      for (const t of threads)
        if (t.forum === e.forum && t.tags.some((tag) => e.tags.includes(tag))) give(t.ownerId, { title: t.title });
    } else if (e.kind === "resolved-help") {
      const helped = new Map();
      for (const t of threads) {
        if (t.forum !== e.forum || !t.tags.some((tag) => e.tags.includes(tag))) continue;
        for (const a of new Set(t.authors)) {
          const m = byId.get(a);
          if (a === t.ownerId || !m || isStaff(m)) continue; // the asker and the team don't earn Helper
          helped.set(a, (helped.get(a) ?? 0) + 1);
        }
      }
      for (const [userId, count] of helped) if (count >= e.count) give(userId, { count });
    } else if (e.kind === "staff-reaction") {
      for (const f of featured) give(f.authorId);
    } else if (e.kind === "joined-before") {
      for (const m of byId.values()) if (m.joinedAt && new Date(m.joinedAt) < new Date(e.before)) give(m.id);
    }
    // "staff" badges are granted by hand; `announceHeld` still gives them a shout-out.
  }
  return awards;
}

/** Badge roles members hold (granted by hand or by an earlier run) that were never announced. */
export function announceHeld({ members, roleIds, announced, badges = S.BADGES }) {
  const out = [];
  for (const m of members) {
    if (m.bot) continue;
    for (const b of badges) {
      if (b.quiet || !m.roles.includes(roleIds[b.role])) continue;
      if (!(announced[m.id] ?? []).includes(b.key)) out.push({ userId: m.id, badge: b, reason: {} });
    }
  }
  return out;
}

/** UTC day of a snowflake id (Discord ids encode their creation time). */
export const snowflakeDay = (id) => new Date(Number((big(id) >> 22n) + 1420070400000n)).toISOString().slice(0, 10);

/** The shout-out message for one award. */
export function shoutPayload(award, { channelIds, emojiIds }) {
  const { userId, badge, reason } = award;
  const role = S.ROLES.find((r) => r.key === badge.role).name;
  const emoji = emojiIds[badge.key];
  const embed = {
    color: Number.parseInt(badge.accent.slice(1), 16),
    title: `New badge: ${role}`,
    description: `<@${userId}> ${badge.shout(reason)}.\n\n*${badge.how}.*`,
    footer: { text: "Badges are earned by making KalCode better. See them all in #welcome." },
  };
  if (emoji) embed.thumbnail = { url: `https://cdn.discordapp.com/emojis/${emoji}.png?size=128` };
  return resolvePayload(
    {
      content: `${emoji ? `<:${badgeEmojiName(badge.key)}:${emoji}> ` : ""}Congrats <@${userId}>!`,
      embeds: [embed],
      allowed_mentions: { users: [userId], parse: [] },
    },
    channelIds,
    emojiIds,
  );
}

// ── Reading the server ─────────────────────────────────────────────────────────────────────────

/** Fetches every message after `after` (oldest first), page by page. */
async function messagesAfter(api, channelId, after) {
  const out = [];
  let cursor = after ?? "0";
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await api.get(`/channels/${channelId}/messages`, { after: cursor, limit: "100" });
    if (!batch.length) break;
    batch.sort((a, b) => (big(a.id) < big(b.id) ? -1 : 1));
    out.push(...batch);
    cursor = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return out;
}

/**
 * Runs recognition against the live server. `ledger` is the persisted state (mutated in place).
 * Returns { granted, shouted, warnings }.
 */
export async function recognize({
  api,
  guildId = S.GUILD_ID,
  ledger,
  dryRun = false,
  log = () => {},
  now = new Date(),
}) {
  const report = { granted: [], shouted: [], warnings: [] };
  ledger.cursors ??= {};
  ledger.days ??= {};
  ledger.threadAuthors ??= {};
  ledger.announced ??= {};
  const firstRun = !ledger.initialized;

  const me = await api.get("/users/@me");
  const roles = await api.get(`/guilds/${guildId}/roles`);
  const roleIds = Object.fromEntries(S.ROLES.map((r) => [r.key, roles.find((x) => x.name === r.name)?.id]));
  const channels = await api.get(`/guilds/${guildId}/channels`);
  const channelIds = {};
  for (const spec of Object.values(S.CHANNELS)) {
    const c = channels.find((x) => x.name === spec.name && (spec.type === "voice" ? x.type === 2 : x.type !== 2));
    if (c) channelIds[spec.key] = c.id;
  }
  const emojis = await api.get(`/guilds/${guildId}/emojis`);
  const emojiIds = Object.fromEntries(
    S.BADGES.map((b) => [b.key, emojis.find((e) => e.name === badgeEmojiName(b.key))?.id]).filter(([, id]) => id),
  );

  // Members (needs the Server Members Intent); fall back to looking up the people we see.
  let members = [];
  const seen = new Set();
  try {
    let after = "0";
    for (;;) {
      const page = await api.get(`/guilds/${guildId}/members`, { limit: "1000", after });
      members.push(...page);
      if (page.length < 1000) break;
      after = page[page.length - 1].user.id;
    }
  } catch (error) {
    if (error.status !== 403) throw error;
    members = null;
    report.warnings.push(
      "Turn on the Server Members Intent (Developer Portal › Bot) so Early Adopter, Veteran and staff-granted badges can be checked for everyone.",
    );
  }

  // Activity: public text channels and forum posts, incrementally.
  const excluded = new Set([
    ...Object.values(S.CHANNELS)
      .filter((c) => c.staff || c.readOnly || c.type === "voice")
      .map((c) => channelIds[c.key]),
    ...S.RECOGNITION.ignoreChannels.map((k) => channelIds[k]),
  ]);
  const record = (msg) => {
    if (msg.author?.bot || !COUNTED_TYPES.has(msg.type ?? 0)) return;
    seen.add(msg.author.id);
    const day = snowflakeDay(msg.id);
    ledger.days[msg.author.id] ??= [];
    if (!ledger.days[msg.author.id].includes(day)) ledger.days[msg.author.id].push(day);
  };
  for (const c of channels.filter((x) => x.type === 0 && !excluded.has(x.id))) {
    const msgs = await messagesAfter(api, c.id, ledger.cursors[c.id]);
    for (const m of msgs) record(m);
    if (msgs.length) ledger.cursors[c.id] = msgs[msgs.length - 1].id;
  }
  const forumKeys = { [channelIds.support]: "support", [channelIds.bugs]: "bugs", [channelIds.features]: "features" };
  const tagNames = {};
  for (const id of Object.keys(forumKeys)) {
    const f = channels.find((c) => c.id === id);
    for (const t of f?.available_tags ?? []) tagNames[t.id] = t.name;
  }
  const allThreads = [
    ...(await api.get(`/guilds/${guildId}/threads/active`)).threads,
    ...(
      await Promise.all(
        Object.keys(forumKeys)
          .filter(Boolean)
          .map((id) => api.get(`/channels/${id}/threads/archived/public`).then((r) => r.threads)),
      )
    ).flat(),
  ];
  const threads = [];
  for (const t of allThreads) {
    if (excluded.has(t.parent_id)) continue;
    const msgs = await messagesAfter(api, t.id, ledger.cursors[t.id]);
    for (const m of msgs) record(m);
    if (msgs.length) ledger.cursors[t.id] = msgs[msgs.length - 1].id;
    const authors = new Set(ledger.threadAuthors[t.id] ?? []);
    for (const m of msgs) if (!m.author?.bot) authors.add(m.author.id);
    ledger.threadAuthors[t.id] = [...authors];
    if (forumKeys[t.parent_id] && t.owner_id !== me.id)
      threads.push({
        id: t.id,
        forum: forumKeys[t.parent_id],
        ownerId: t.owner_id,
        title: t.name,
        tags: (t.applied_tags ?? []).map((id) => tagNames[id]).filter(Boolean),
        authors: [...authors],
      });
  }

  // Showcase posts a team member starred (recent ones; reactions can arrive late).
  const featured = [];
  const showcaseBadge = S.BADGES.find((b) => b.earn.kind === "staff-reaction");
  if (showcaseBadge && channelIds[showcaseBadge.earn.channel]) {
    const cid = channelIds[showcaseBadge.earn.channel];
    const recent = await api.get(`/channels/${cid}/messages`, { limit: "100" });
    const staffRoleIds = new Set(S.STAFF_ROLES.map((k) => roleIds[k]).filter(Boolean));
    const memberCache = new Map((members ?? []).map((m) => [m.user.id, m]));
    const memberOf = async (id) => {
      if (!memberCache.has(id))
        memberCache.set(id, await api.get(`/guilds/${guildId}/members/${id}`).catch(() => null));
      return memberCache.get(id);
    };
    for (const m of recent) {
      if (m.author?.bot || !m.reactions?.some((r) => r.emoji?.name === showcaseBadge.earn.emoji)) continue;
      const users = await api.get(
        `/channels/${cid}/messages/${m.id}/reactions/${encodeURIComponent(showcaseBadge.earn.emoji)}`,
        { limit: "100" },
      );
      for (const u of users) {
        const mem = await memberOf(u.id);
        if (mem?.roles?.some((r) => staffRoleIds.has(r))) {
          featured.push({ messageId: m.id, authorId: m.author.id });
          seen.add(m.author.id);
          break;
        }
      }
    }
  }

  // Without the member list, look up everyone we saw act.
  if (!members) {
    members = [];
    for (const id of new Set([...seen, ...threads.map((t) => t.ownerId)])) {
      const m = await api.get(`/guilds/${guildId}/members/${id}`).catch(() => null);
      if (m) members.push(m);
    }
  }
  const people = members.map((m) => ({
    id: m.user.id,
    bot: Boolean(m.user.bot),
    joinedAt: m.joined_at,
    roles: m.roles,
  }));

  // Decide, then grant (additive), then announce.
  const awards = decideAwards({ members: people, activeDays: ledger.days, threads, featured, roleIds, now });
  for (const a of awards) {
    const role = S.ROLES.find((r) => r.key === a.badge.role).name;
    log(`${dryRun ? "[plan] " : ""}+ ${role} → ${a.userId}`);
    report.granted.push({ userId: a.userId, badge: a.badge.key });
    if (!dryRun) {
      await api.put(`/guilds/${guildId}/members/${a.userId}/roles/${roleIds[a.badge.role]}`);
      const p = people.find((x) => x.id === a.userId);
      if (p) p.roles = [...p.roles, roleIds[a.badge.role]];
    }
  }
  // A first run only takes stock: badges people already hold are recorded, not announced.
  const pending = [
    ...awards.filter((a) => !a.badge.quiet),
    ...announceHeld({ members: people, roleIds, announced: ledger.announced }).filter(
      (h) => !awards.some((a) => a.userId === h.userId && a.badge.key === h.badge.key),
    ),
  ];
  let budget = S.RECOGNITION.maxShoutsPerRun;
  const shoutChannel = channelIds[S.RECOGNITION.shoutChannel];
  for (const p of pending) {
    const isNew = awards.includes(p);
    const announce = shoutChannel && budget > 0 && (isNew || !firstRun);
    if (announce) {
      budget--;
      log(`${dryRun ? "[plan] " : ""}📣 ${p.badge.key} → ${p.userId}`);
      if (!dryRun) await api.post(`/channels/${shoutChannel}/messages`, shoutPayload(p, { channelIds, emojiIds }));
      report.shouted.push({ userId: p.userId, badge: p.badge.key });
    }
    // Record it as announced when it was, or when it's an existing badge seen on the first run. A new
    // badge that overflowed the cap stays pending, so the next run announces it.
    if (!dryRun && (announce || (firstRun && !isNew))) {
      ledger.announced[p.userId] ??= [];
      ledger.announced[p.userId].push(p.badge.key);
    }
  }
  if (!dryRun) ledger.initialized = true;
  return report;
}
