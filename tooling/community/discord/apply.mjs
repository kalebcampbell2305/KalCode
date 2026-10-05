// Reconciles the live KalCode Discord with server.mjs + content.mjs. Idempotent: it adopts existing
// roles/channels/rules by name, creates what is missing, updates what differs and leaves everything
// else alone. It never deletes a channel, role or message it does not own (the only deletions are
// Discord's empty default categories and the bot's own outdated #roadmap messages).
//
// Order matters: Discord requires the Community feature before announcement channels, forums,
// onboarding and the welcome screen, and Community requires the rules and updates channels first.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { changelogPost, changelogTitle, readRelease } from "./changelog.mjs";
import { FORUM_GUIDES, MESSAGES, resolvePayload } from "./content.mjs";
import { roadmapMessages } from "./roadmap.mjs";
import * as S from "./server.mjs";

const { P } = S;
export const CHANNEL_TYPE = { text: 0, voice: 2, category: 4, announcement: 5, forum: 15 };
const READ_ONLY_DENY = S.perms(
  P.SEND_MESSAGES,
  P.SEND_MESSAGES_IN_THREADS,
  P.CREATE_PUBLIC_THREADS,
  P.CREATE_PRIVATE_THREADS,
);
const STAFF_ALLOW = S.perms(P.VIEW_CHANNEL, P.SEND_MESSAGES, P.READ_MESSAGE_HISTORY, P.ATTACH_FILES, P.EMBED_LINKS);
const TEAM_POST = S.perms(P.SEND_MESSAGES, P.SEND_MESSAGES_IN_THREADS, P.CREATE_PUBLIC_THREADS);
const TRIGGER = { keyword: 1, spam: 3, keyword_preset: 4, mention_spam: 5, member_profile: 6 };
const SINGLETON_TRIGGERS = new Set([3, 4, 5, 6]);
const FORUM_PINNED = 1 << 1;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const dataUri = (path) => `data:image/png;base64,${readFileSync(path).toString("base64")}`;
const lower = (s) => String(s).toLowerCase();

/** Stable JSON for comparisons (sorted keys, bigints as strings). */
export function stable(value) {
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** A Discord snowflake for new onboarding prompts/options (ids must be unique snowflakes). */
export function snowflake(seq, now = Date.now()) {
  return String(((BigInt(now) - 1420070400000n) << 22n) | BigInt(seq & 0x3fffff));
}

/** Base permissions of a member from their roles (Administrator implies all). */
export function memberPermissions(memberRoleIds, roles, guildId) {
  const byId = new Map(roles.map((r) => [r.id, BigInt(r.permissions)]));
  let p = byId.get(guildId) ?? 0n;
  for (const id of memberRoleIds) p |= byId.get(id) ?? 0n;
  return p;
}

export function overwritesFor(spec, roleIds, guildId) {
  if (spec.staff) {
    return [
      { id: guildId, type: 0, allow: "0", deny: String(P.VIEW_CHANNEL) },
      ...S.STAFF_ROLES.map((k) => ({ id: roleIds[k], type: 0, allow: String(STAFF_ALLOW), deny: "0" })),
    ];
  }
  if (spec.readOnly) {
    return [
      { id: guildId, type: 0, allow: "0", deny: String(READ_ONLY_DENY) },
      { id: roleIds.team, type: 0, allow: String(TEAM_POST), deny: "0" },
    ];
  }
  return [];
}

const normOverwrites = (list = []) =>
  stable(
    list
      .map((o) => ({ id: o.id, type: Number(o.type), allow: String(o.allow), deny: String(o.deny) }))
      .filter((o) => o.allow !== "0" || o.deny !== "0")
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  );

/**
 * Applies the declared server. `api` is a client from discord-api.mjs (or a fake). In dry-run mode
 * every read happens but every write is only reported.
 */
export async function applyServer({
  api,
  repoRoot,
  guildId = S.GUILD_ID,
  dryRun = false,
  log = () => {},
  plansGroups,
  changelogIds = [],
  state = {},
  webhookStore = { get: () => ({}), set: () => {} },
}) {
  const report = { created: [], updated: [], unchanged: [], skipped: [], warnings: [], invite: null, state };
  let fakeId = 0;
  const write = async (label, kind, fn, fake) => {
    report[kind].push(label);
    log(`${dryRun ? "[plan] " : ""}${kind === "created" ? "+" : "~"} ${label}`);
    if (dryRun) return fake ?? { id: `planned-${++fakeId}` };
    return fn();
  };
  const same = (label) => report.unchanged.push(label);
  const asset = (rel) => join(repoRoot, rel);

  // ── Read the server ────────────────────────────────────────────────────────────────────────
  const me = await api.get("/users/@me");
  const guild = await api.get(`/guilds/${guildId}`);
  let roles = await api.get(`/guilds/${guildId}/roles`);
  let channels = await api.get(`/guilds/${guildId}/channels`);
  const botMember = await api.get(`/guilds/${guildId}/members/${me.id}`);
  const botPerms = memberPermissions(botMember.roles, roles, guildId);
  if ((botPerms & P.ADMINISTRATOR) === 0n)
    throw new Error(
      "The KalCode bot needs the Administrator permission for setup (enabling Community, onboarding and AutoMod require it). Re-invite it with the link from `kc-discord.mjs invite-url`, or give its role Administrator.",
    );
  const botTop = Math.max(...roles.filter((r) => botMember.roles.includes(r.id)).map((r) => r.position));

  // ── Roles ──────────────────────────────────────────────────────────────────────────────────
  const roleIds = {};
  for (const spec of S.ROLES) {
    const want = {
      name: spec.name,
      permissions: String(spec.permissions),
      color: spec.color,
      hoist: spec.hoist,
      mentionable: spec.mentionable,
    };
    const have = roles.find((r) => r.name === spec.name && !r.managed);
    if (!have) {
      const created = await write(`role ${spec.name}`, "created", () => api.post(`/guilds/${guildId}/roles`, want));
      roleIds[spec.key] = created.id;
      continue;
    }
    roleIds[spec.key] = have.id;
    if (have.position >= botTop) {
      report.warnings.push(
        `Role "${spec.name}" sits above the bot's role; move the KalCode bot's role to the top to manage it.`,
      );
      continue;
    }
    const differs =
      String(have.permissions) !== want.permissions ||
      have.color !== want.color ||
      have.hoist !== want.hoist ||
      have.mentionable !== want.mentionable;
    if (differs)
      await write(`role ${spec.name}`, "updated", () => api.patch(`/guilds/${guildId}/roles/${have.id}`, want));
    else same(`role ${spec.name}`);
  }
  const everyone = roles.find((r) => r.id === guildId);
  if (everyone && String(everyone.permissions) !== String(S.EVERYONE_PERMISSIONS))
    await write("@everyone permissions", "updated", () =>
      api.patch(`/guilds/${guildId}/roles/${guildId}`, { permissions: String(S.EVERYONE_PERMISSIONS) }),
    );
  else same("@everyone permissions");

  // Order: Owner, KalCode Team, … Member, directly beneath the bot's role.
  if (!dryRun) roles = await api.get(`/guilds/${guildId}/roles`);
  const ordered = S.ROLES.map((r) => roles.find((x) => x.id === roleIds[r.key])).filter(Boolean);
  const inOrder = ordered.every((r, i) => i === 0 || ordered[i - 1].position > r.position);
  if (!inOrder || ordered.length !== S.ROLES.length) {
    // Creating roles moves the bot's role up, so measure it again before placing ours beneath it.
    const botNow = Math.max(...roles.filter((r) => botMember.roles.includes(r.id)).map((r) => r.position));
    const positions = S.ROLES.map((r, i) => ({ id: roleIds[r.key], position: Math.max(1, botNow - 1 - i) }));
    await write("role order", "updated", () => api.patch(`/guilds/${guildId}/roles`, positions));
  } else same("role order");

  // The owner wears the Owner role.
  try {
    const owner = await api.get(`/guilds/${guildId}/members/${S.OWNER_USER_ID}`);
    if (!owner.roles.includes(roleIds.owner))
      await write("Owner role → server owner", "updated", () =>
        api.put(`/guilds/${guildId}/members/${S.OWNER_USER_ID}/roles/${roleIds.owner}`),
      );
    else same("Owner role → server owner");
  } catch (error) {
    report.warnings.push(`Couldn't give the owner the Owner role: ${error.message}`);
  }

  // ── Categories and channels ────────────────────────────────────────────────────────────────
  const channelIds = {};
  const categoryIds = {};
  const findChannel = (spec) =>
    channels.find((c) =>
      spec.type === "voice"
        ? c.type === CHANNEL_TYPE.voice && lower(c.name) === lower(spec.name)
        : [CHANNEL_TYPE.text, CHANNEL_TYPE.announcement, CHANNEL_TYPE.forum].includes(c.type) && c.name === spec.name,
    );

  for (const [ci, cat] of S.CATEGORIES.entries()) {
    const overwrites = cat.staff ? overwritesFor({ staff: true }, roleIds, guildId) : [];
    const have = channels.find((c) => c.type === CHANNEL_TYPE.category && lower(c.name) === lower(cat.name));
    if (!have) {
      const created = await write(`category ${cat.name}`, "created", () =>
        api.post(`/guilds/${guildId}/channels`, {
          name: cat.name,
          type: 4,
          position: ci,
          permission_overwrites: overwrites,
        }),
      );
      categoryIds[cat.key] = created.id;
    } else {
      categoryIds[cat.key] = have.id;
      if (have.name !== cat.name || normOverwrites(have.permission_overwrites) !== normOverwrites(overwrites))
        await write(`category ${cat.name}`, "updated", () =>
          api.patch(`/channels/${have.id}`, { name: cat.name, permission_overwrites: overwrites }),
        );
      else same(`category ${cat.name}`);
    }
  }

  const needsCommunity = (spec) => spec.type === "announcement" || spec.type === "forum";
  const communityAtStart = guild.features.includes("COMMUNITY");
  const hasCommunity = () => guild.features.includes("COMMUNITY");
  const channelBody = (spec, { asType } = {}) => {
    const body = {
      name: spec.name,
      type: CHANNEL_TYPE[asType ?? spec.type],
      parent_id: categoryIds[spec.category],
      permission_overwrites: overwritesFor(spec, roleIds, guildId),
    };
    if (spec.type !== "voice") body.topic = spec.topic ?? "";
    if (spec.type === "forum") {
      const f = S.FORUMS[spec.forum];
      body.available_tags = f.tags.map((t) => ({ name: t.name, moderated: Boolean(t.moderated) }));
      body.default_reaction_emoji = f.reaction ? { emoji_name: f.reaction, emoji_id: null } : null;
      body.default_sort_order = 0; // latest activity
      body.default_forum_layout = 1; // list
    }
    return body;
  };

  const ensureChannel = async (spec, { phase }) => {
    const have = findChannel(spec);
    if (!have) {
      if (needsCommunity(spec) && phase === "before") return; // created after Community is on
      const created = await write(`#${spec.name}`, "created", () =>
        api.post(`/guilds/${guildId}/channels`, channelBody(spec)),
      );
      channelIds[spec.key] = created.id;
      channels.push({ ...created, ...channelBody(spec), id: created.id });
      return;
    }
    channelIds[spec.key] = have.id;
    if (phase === "before" && needsCommunity(spec)) return; // reconcile after Community is on
    const want = channelBody(spec);
    const patch = {};
    if (have.name !== want.name) patch.name = want.name;
    if (have.parent_id !== want.parent_id) patch.parent_id = want.parent_id;
    if (spec.type !== "voice" && (have.topic ?? "") !== want.topic) patch.topic = want.topic;
    if (normOverwrites(have.permission_overwrites) !== normOverwrites(want.permission_overwrites))
      patch.permission_overwrites = want.permission_overwrites;
    if (spec.type === "announcement" && have.type === CHANNEL_TYPE.text && hasCommunity()) patch.type = 5;
    if (spec.type === "forum") {
      const tags = [...(have.available_tags ?? [])];
      let tagsChanged = false;
      for (const t of want.available_tags) {
        const i = tags.findIndex((x) => x.name === t.name);
        if (i < 0) {
          tags.push(t);
          tagsChanged = true;
        } else if (Boolean(tags[i].moderated) !== t.moderated) {
          tags[i] = { ...tags[i], moderated: t.moderated };
          tagsChanged = true;
        }
      }
      if (tagsChanged) patch.available_tags = tags;
      if ((have.default_reaction_emoji?.emoji_name ?? null) !== (want.default_reaction_emoji?.emoji_name ?? null))
        patch.default_reaction_emoji = want.default_reaction_emoji;
    }
    if (Object.keys(patch).length)
      await write(`#${spec.name} (${Object.keys(patch).join(", ")})`, "updated", () =>
        api.patch(`/channels/${have.id}`, patch),
      );
    else same(`#${spec.name}`);
  };

  const allSpecs = Object.values(S.CHANNELS);
  for (const spec of allSpecs) await ensureChannel(spec, { phase: "before" });

  // ── Guild settings and the Community feature ───────────────────────────────────────────────
  const G = S.GUILD_SETTINGS;
  const guildPatch = {};
  const setIf = (key, value) => {
    if (guild[key] !== value) guildPatch[key] = value;
  };
  setIf("name", G.name);
  setIf("verification_level", G.verificationLevel);
  setIf("explicit_content_filter", G.explicitContentFilter);
  setIf("default_message_notifications", G.defaultMessageNotifications);
  setIf("preferred_locale", G.preferredLocale);
  setIf("system_channel_id", channelIds[G.systemChannel]);
  setIf("system_channel_flags", G.systemChannelFlags);
  setIf("rules_channel_id", channelIds[G.rulesChannel]);
  setIf("public_updates_channel_id", channelIds[G.publicUpdatesChannel]);
  setIf("safety_alerts_channel_id", channelIds[G.safetyAlertsChannel]);
  if (!guild.features.includes("COMMUNITY")) guildPatch.features = [...new Set([...guild.features, "COMMUNITY"])];
  const iconPath = asset(G.icon);
  if (existsSync(iconPath)) {
    const iconSha = sha256(readFileSync(iconPath));
    if (state.iconSha !== iconSha || state.iconHash !== guild.icon) {
      guildPatch.icon = dataUri(iconPath);
      state.pendingIconSha = iconSha;
    }
  } else report.warnings.push(`Icon asset missing: ${G.icon}`);
  for (const [field, feature, rel, tier] of [
    ["banner", "BANNER", G.banner, 2],
    ["splash", "INVITE_SPLASH", G.splash, 1],
  ]) {
    if (!guild.features.includes(feature)) {
      report.skipped.push(`${field}: needs server boost level ${tier} (asset ready: ${rel})`);
      continue;
    }
    const p = asset(rel);
    const sha = sha256(readFileSync(p));
    if (state[`${field}Sha`] !== sha) {
      guildPatch[field] = dataUri(p);
      state[`pending_${field}Sha`] = sha;
    }
  }
  if (Object.keys(guildPatch).length) {
    const label = `server settings (${Object.keys(guildPatch).join(", ")})`;
    const updated = await write(label, "updated", () => api.patch(`/guilds/${guildId}`, guildPatch));
    if (!dryRun) {
      Object.assign(guild, updated);
      if (guildPatch.icon) {
        state.iconSha = state.pendingIconSha;
        state.iconHash = updated.icon;
      }
      for (const field of ["banner", "splash"])
        if (guildPatch[field]) state[`${field}Sha`] = state[`pending_${field}Sha`];
    } else if (guildPatch.features) guild.features = guildPatch.features;
    delete state.pendingIconSha;
    delete state.pending_bannerSha;
    delete state.pending_splashSha;
  } else same("server settings");
  if (G.description && guild.description !== G.description)
    await write("server description", "updated", () => api.patch(`/guilds/${guildId}`, { description: G.description }));

  // ── Community-only channels, then order everything ─────────────────────────────────────────
  if (!dryRun) channels = await api.get(`/guilds/${guildId}/channels`);
  for (const spec of allSpecs) await ensureChannel(spec, { phase: "after" });

  const positions = [];
  for (const [ci, cat] of S.CATEGORIES.entries()) {
    positions.push({ id: categoryIds[cat.key], position: ci });
    cat.channels.forEach((ch, i) => {
      if (channelIds[ch.key]) positions.push({ id: channelIds[ch.key], position: i, parent_id: categoryIds[cat.key] });
    });
  }
  const current = new Map(channels.map((c) => [c.id, c]));
  const misplaced = positions.some((p) => {
    const c = current.get(p.id);
    return !c || c.position !== p.position || (p.parent_id && c.parent_id !== p.parent_id);
  });
  if (misplaced) await write("channel order", "updated", () => api.patch(`/guilds/${guildId}/channels`, positions));
  else same("channel order");

  // Discord's empty default categories go; any other unmanaged channel is reported, never deleted.
  const managed = new Set([...Object.values(channelIds), ...Object.values(categoryIds)]);
  for (const c of channels) {
    if (managed.has(c.id)) continue;
    const children = channels.filter((x) => x.parent_id === c.id && !managed.has(x.id));
    const movedAway = channels.filter((x) => x.parent_id === c.id).every((x) => managed.has(x.id));
    if (
      c.type === CHANNEL_TYPE.category &&
      S.DISCORD_DEFAULT_CATEGORIES.includes(c.name) &&
      !children.length &&
      movedAway
    )
      await write(`remove empty default category "${c.name}"`, "updated", () => api.delete(`/channels/${c.id}`));
    else if (c.type !== CHANNEL_TYPE.category || children.length)
      report.warnings.push(`Unmanaged channel left in place: ${c.type === 2 ? "🔊" : "#"}${c.name}`);
  }

  // ── AutoMod ────────────────────────────────────────────────────────────────────────────────
  const rules = await api.get(`/guilds/${guildId}/auto-moderation/rules`);
  const staffRoleIds = S.STAFF_ROLES.map((k) => roleIds[k]).filter(Boolean);
  for (const spec of S.AUTOMOD_RULES) {
    const want = automodPayload(spec, { alertChannel: channelIds.reports, staffRoleIds });
    const have =
      rules.find((r) => r.name === spec.name) ??
      (SINGLETON_TRIGGERS.has(want.trigger_type) ? rules.find((r) => r.trigger_type === want.trigger_type) : undefined);
    if (!have) {
      await write(`AutoMod: ${spec.name}`, "created", () => api.post(`/guilds/${guildId}/auto-moderation/rules`, want));
      continue;
    }
    const { trigger_type: _t, ...patch } = want;
    const cmp = (r) =>
      stable({
        name: r.name,
        event_type: r.event_type,
        trigger_metadata: r.trigger_metadata,
        actions: r.actions,
        enabled: r.enabled,
        exempt_roles: [...(r.exempt_roles ?? [])].sort(),
      });
    if (cmp(have) !== cmp({ ...want, exempt_roles: [...want.exempt_roles].sort() }))
      await write(`AutoMod: ${spec.name}`, "updated", () =>
        api.patch(`/guilds/${guildId}/auto-moderation/rules/${have.id}`, patch),
      );
    else same(`AutoMod: ${spec.name}`);
  }

  // ── Messages ───────────────────────────────────────────────────────────────────────────────
  const history = new Map();
  const botMessages = async (channelId) => {
    if (!channelId || String(channelId).startsWith("planned-")) return [];
    if (!history.has(channelId)) {
      const msgs = await api.get(`/channels/${channelId}/messages`, { limit: "100" });
      history.set(
        channelId,
        msgs.filter((m) => m.author?.id === me.id),
      );
    }
    return history.get(channelId);
  };
  const embedKey = (embeds) =>
    stable(
      (embeds ?? []).map((e) => ({
        title: e.title,
        description: e.description,
        url: e.url,
        color: e.color,
        fields: (e.fields ?? []).map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) })),
        footer: e.footer?.text,
        image: e.image?.url,
      })),
    );
  const upsertMessage = async (channelKey, title, payload, { publish = false } = {}) => {
    const channelId = channelIds[channelKey];
    const body = resolvePayload({ ...payload, allowed_mentions: { parse: [] } }, channelIds);
    delete body._meta;
    const existing = (await botMessages(channelId)).find((m) => m.embeds?.[0]?.title === title);
    if (!existing) {
      const msg = await write(`message "${title}" in #${S.CHANNELS[channelKey].name}`, "created", () =>
        api.post(`/channels/${channelId}/messages`, body),
      );
      if (publish && !dryRun) await api.post(`/channels/${channelId}/messages/${msg.id}/crosspost`).catch(() => {});
      return;
    }
    if (embedKey(existing.embeds) !== embedKey(body.embeds))
      await write(`message "${title}" in #${S.CHANNELS[channelKey].name}`, "updated", () =>
        api.patch(`/channels/${channelId}/messages/${existing.id}`, { embeds: body.embeds }),
      );
    else same(`message "${title}"`);
  };

  for (const m of MESSAGES)
    await upsertMessage(m.channel, m.embeds[0].title, { embeds: m.embeds }, { publish: m.channel === "announcements" });

  // #roadmap: generated; reposted in full when its shape changes (it's the bot's own read-only channel).
  if (plansGroups) {
    const wanted = roadmapMessages(plansGroups).map((m) => resolvePayload({ embeds: m.embeds }, channelIds));
    const existing = [...(await botMessages(channelIds.roadmap))].reverse(); // oldest first
    const sameShape =
      existing.length === wanted.length && existing.every((m, i) => m.embeds?.length === wanted[i].embeds.length);
    if (sameShape) {
      for (const [i, m] of existing.entries()) {
        if (embedKey(m.embeds) !== embedKey(wanted[i].embeds))
          await write(`#roadmap message ${i + 1}`, "updated", () =>
            api.patch(`/channels/${channelIds.roadmap}/messages/${m.id}`, { embeds: wanted[i].embeds }),
          );
        else same(`#roadmap message ${i + 1}`);
      }
    } else {
      for (const m of existing)
        await write("remove outdated #roadmap message", "updated", () =>
          api.delete(`/channels/${channelIds.roadmap}/messages/${m.id}`),
        );
      for (const [i, m] of wanted.entries())
        await write(`#roadmap message ${i + 1}`, "created", () =>
          api.post(`/channels/${channelIds.roadmap}/messages`, { ...m, allowed_mentions: { parse: [] } }),
        );
    }
  }

  // #changelog: one post per release, oldest first, never duplicated.
  for (const id of changelogIds) {
    const post = changelogPost(id, readRelease(repoRoot, id));
    await upsertMessage("changelog", changelogTitle(id), post, { publish: true });
  }

  // ── Forum guides (pinned, locked "start here" posts) ───────────────────────────────────────
  let threads = null;
  for (const g of FORUM_GUIDES) {
    const forumId = channelIds[g.channel];
    const embeds = resolvePayload(g.embeds, channelIds);
    if (!forumId || String(forumId).startsWith("planned-")) {
      await write(`guide "${g.title}"`, "created", async () => ({}));
      continue;
    }
    threads ??= [
      ...(await api.get(`/guilds/${guildId}/threads/active`)).threads,
      ...(
        await Promise.all(
          ["support", "bugs", "features"].map((k) =>
            channelIds[k] ? api.get(`/channels/${channelIds[k]}/threads/archived/public`).then((r) => r.threads) : [],
          ),
        )
      ).flat(),
    ];
    const have = threads.find((t) => t.parent_id === forumId && t.name === g.title && t.owner_id === me.id);
    if (!have) {
      const thread = await write(`guide "${g.title}"`, "created", () =>
        api.post(`/channels/${forumId}/threads`, {
          name: g.title,
          message: { embeds, allowed_mentions: { parse: [] } },
        }),
      );
      if (!dryRun) await api.patch(`/channels/${thread.id}`, { flags: FORUM_PINNED, locked: true });
      continue;
    }
    const starter = await api.get(`/channels/${have.id}/messages/${have.id}`).catch(() => null);
    if (starter && embedKey(starter.embeds) !== embedKey(embeds))
      await write(`guide "${g.title}"`, "updated", () =>
        api.patch(`/channels/${have.id}/messages/${have.id}`, { embeds }),
      );
    else same(`guide "${g.title}"`);
    if (!(have.flags & FORUM_PINNED) || have.thread_metadata?.archived || !have.thread_metadata?.locked)
      await write(`pin guide "${g.title}"`, "updated", () =>
        api.patch(`/channels/${have.id}`, { flags: FORUM_PINNED, locked: true, archived: false }),
      );
  }

  // ── Onboarding and welcome screen ──────────────────────────────────────────────────────────
  if (hasCommunity() || dryRun) {
    const current = dryRun && !communityAtStart ? { prompts: [] } : await api.get(`/guilds/${guildId}/onboarding`);
    const onboarding = onboardingPayload({ current, channelIds, roleIds });
    const cmp = (o) =>
      stable({
        enabled: o.enabled,
        mode: o.mode,
        default_channel_ids: [...(o.default_channel_ids ?? [])].sort(),
        prompts: (o.prompts ?? []).map((p) => ({
          title: p.title,
          single_select: p.single_select,
          required: p.required,
          options: p.options.map((x) => ({
            title: x.title,
            description: x.description,
            channel_ids: [...(x.channel_ids ?? [])].sort(),
            role_ids: [...(x.role_ids ?? [])].sort(),
          })),
        })),
      });
    if (cmp(current) !== cmp(onboarding))
      await write("onboarding", "updated", () => api.put(`/guilds/${guildId}/onboarding`, onboarding));
    else same("onboarding");

    const screen = {
      enabled: true,
      description: S.WELCOME_SCREEN.description,
      welcome_channels: S.WELCOME_SCREEN.channels.map((c) => ({
        channel_id: channelIds[c.channel],
        description: c.description,
        emoji_id: null,
        emoji_name: null,
      })),
    };
    const haveScreen =
      dryRun && !communityAtStart ? null : await api.get(`/guilds/${guildId}/welcome-screen`).catch(() => null);
    const screenKey = (w) =>
      stable({
        description: w?.description ?? null,
        channels: (w?.welcome_channels ?? []).map((c) => ({ id: c.channel_id, d: c.description })),
      });
    if (screenKey(haveScreen) !== screenKey(screen))
      await write("welcome screen", "updated", () => api.patch(`/guilds/${guildId}/welcome-screen`, screen));
    else same("welcome screen");
  }

  // ── Permanent invite ───────────────────────────────────────────────────────────────────────
  const welcomeId = channelIds[S.INVITE.channel];
  const invites = dryRun && String(welcomeId).startsWith("planned-") ? [] : await api.get(`/guilds/${guildId}/invites`);
  const permanent = invites.find((i) => i.channel?.id === welcomeId && i.max_age === 0 && i.max_uses === 0);
  if (permanent) {
    report.invite = `https://discord.gg/${permanent.code}`;
    same("permanent invite");
  } else {
    const inv = await write("permanent invite on #welcome", "created", () =>
      api.post(`/channels/${welcomeId}/invites`, { max_age: 0, max_uses: 0, unique: false }),
    );
    report.invite = inv.code ? `https://discord.gg/${inv.code}` : "(created on apply)";
  }

  // ── Release webhooks (URLs saved locally, never printed) ───────────────────────────────────
  const hooks = { ...webhookStore.get() };
  for (const w of S.WEBHOOKS) {
    const cid = channelIds[w.channel];
    if (!cid || String(cid).startsWith("planned-")) {
      await write(`webhook ${w.name} on #${w.channel}`, "created", async () => ({}));
      continue;
    }
    const existing = (await api.get(`/channels/${cid}/webhooks`)).find((h) => h.name === w.name && h.token);
    if (existing && hooks[w.key]?.includes(`/${existing.id}/`)) {
      same(`webhook ${w.name}`);
      continue;
    }
    const hook =
      existing ??
      (await write(`webhook ${w.name} on #${w.channel}`, "created", () =>
        api.post(
          `/channels/${cid}/webhooks`,
          existsSync(iconPath) ? { name: w.name, avatar: dataUri(iconPath) } : { name: w.name },
        ),
      ));
    if (!dryRun && hook.token) hooks[w.key] = `https://discord.com/api/webhooks/${hook.id}/${hook.token}`;
  }
  if (!dryRun) webhookStore.set(hooks);

  return report;
}

export function automodPayload(spec, { alertChannel, staffRoleIds }) {
  const trigger_type = TRIGGER[spec.trigger];
  const actions = [];
  if (spec.trigger === "member_profile") actions.push({ type: 4, metadata: {} });
  else actions.push({ type: 1, metadata: spec.block ? { custom_message: spec.block } : {} });
  if (spec.alert && alertChannel) actions.push({ type: 2, metadata: { channel_id: alertChannel } });
  if (spec.timeoutSeconds) actions.push({ type: 3, metadata: { duration_seconds: spec.timeoutSeconds } });
  const trigger_metadata = {
    keyword: { keyword_filter: spec.keywords ?? [], regex_patterns: spec.regex ?? [], allow_list: [] },
    spam: {},
    keyword_preset: { presets: spec.presets ?? [], allow_list: [] },
    mention_spam: { mention_total_limit: spec.mentionLimit, mention_raid_protection_enabled: true },
    member_profile: { keyword_filter: spec.keywords ?? [], regex_patterns: [], allow_list: [] },
  }[spec.trigger];
  return {
    name: spec.name,
    event_type: spec.trigger === "member_profile" ? 2 : 1,
    trigger_type,
    trigger_metadata,
    actions,
    enabled: true,
    exempt_roles: spec.exemptStaff ? staffRoleIds : [],
    exempt_channels: [],
  };
}

export function onboardingPayload({ current, channelIds, roleIds, now = Date.now() }) {
  let seq = 0;
  const idFor = (list, title) => list?.find((x) => x.title === title)?.id ?? snowflake(++seq, now);
  return {
    enabled: true,
    mode: 0,
    default_channel_ids: S.ONBOARDING.defaultChannels.map((k) => channelIds[k]).filter(Boolean),
    prompts: S.ONBOARDING.prompts.map((p) => {
      const existing = current?.prompts?.find((x) => x.title === p.title);
      return {
        id: existing?.id ?? snowflake(++seq, now),
        type: 0,
        title: p.title,
        single_select: p.singleSelect,
        required: p.required,
        in_onboarding: true,
        options: p.options.map((o) => ({
          id: idFor(existing?.options, o.title),
          title: o.title,
          description: o.description,
          channel_ids: (o.channels ?? []).map((k) => channelIds[k]).filter(Boolean),
          role_ids: (o.roles ?? []).map((k) => roleIds[k]).filter(Boolean),
        })),
      };
    }),
  };
}
