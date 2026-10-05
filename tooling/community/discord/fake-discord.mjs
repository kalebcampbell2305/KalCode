// An in-memory Discord for tests: just enough of the REST API that `apply` uses, with the real rules
// that matter (Community before forums/announcement channels, Community needs rules + updates
// channels and stricter moderation, owner-only role positions). It records every request.
export const FAKE_TOKEN = `${Buffer.from("123456789012345678").toString("base64")}.Gx1234.${"t".repeat(27)}`;
const BOT_ID = "123456789012345678";

export function createFakeDiscord({ guildId = "1554995816639369348", ownerId = "1541801222867255346" } = {}) {
  let seq = 900000000000000000n;
  const id = () => String(++seq);
  const s = {
    guild: {
      id: guildId,
      name: "KalCode",
      icon: "oldicon",
      description: null,
      features: [],
      verification_level: 0,
      explicit_content_filter: 0,
      default_message_notifications: 0,
      preferred_locale: "en-US",
      system_channel_id: null,
      system_channel_flags: 0,
      rules_channel_id: null,
      public_updates_channel_id: null,
      safety_alerts_channel_id: null,
    },
    roles: [
      {
        id: guildId,
        name: "@everyone",
        permissions: "1071698660929",
        position: 0,
        color: 0,
        hoist: false,
        mentionable: false,
        managed: false,
      },
      {
        id: "500",
        name: "KalCode Bot",
        permissions: "8",
        position: 1,
        color: 0,
        hoist: false,
        mentionable: false,
        managed: true,
      },
    ],
    members: { [BOT_ID]: { roles: ["500"] }, [ownerId]: { roles: [] } },
    channels: [
      { id: "10", name: "Text Channels", type: 4, position: 0, parent_id: null, permission_overwrites: [] },
      { id: "11", name: "Voice Channels", type: 4, position: 1, parent_id: null, permission_overwrites: [] },
      { id: "12", name: "general", type: 0, position: 0, parent_id: "10", topic: null, permission_overwrites: [] },
      { id: "13", name: "General", type: 2, position: 0, parent_id: "11", permission_overwrites: [] },
    ],
    messages: {},
    threads: [],
    automod: [],
    onboarding: { prompts: [], default_channel_ids: [], enabled: false, mode: 0 },
    welcome: null,
    invites: [],
    webhooks: [],
    requests: [],
  };
  const err = (status, message) => ({ status, body: { message, code: 50035 } });
  const chan = (cid) => s.channels.find((c) => c.id === cid) ?? s.threads.find((t) => t.id === cid);

  function route(method, path, body) {
    const p = path.replace(/^\/api\/v10/, "");
    let m;
    if (method === "GET" && p === "/users/@me") return { id: BOT_ID, username: "KalCode", bot: true };
    m = /^\/guilds\/(\d+)$/.exec(p);
    if (m) {
      if (method === "GET") return s.guild;
      if (method === "PATCH") {
        if (body.features?.includes("COMMUNITY") && !s.guild.features.includes("COMMUNITY")) {
          const next = { ...s.guild, ...body };
          if (!next.rules_channel_id || !next.public_updates_channel_id)
            return err(400, "Community needs rules and updates channels");
          if (next.verification_level < 1 || next.explicit_content_filter !== 2)
            return err(400, "Community needs verification and the explicit content filter");
        }
        Object.assign(s.guild, body);
        if (body.icon) s.guild.icon = `hash${seq}`;
        return s.guild;
      }
    }
    m = /^\/guilds\/\d+\/roles$/.exec(p);
    if (m) {
      if (method === "GET") return s.roles;
      if (method === "POST") {
        const r = { id: id(), position: 1, managed: false, ...body };
        for (const x of s.roles) if (x.position >= 1 && x.id !== s.guild.id) x.position += 1;
        s.roles.push(r);
        return r;
      }
      if (method === "PATCH") {
        for (const { id: rid, position } of body) s.roles.find((r) => r.id === rid).position = position;
        // keep the bot on top
        const bot = s.roles.find((r) => r.id === "500");
        bot.position = Math.max(...s.roles.map((r) => r.position)) + 1;
        return s.roles;
      }
    }
    m = /^\/guilds\/\d+\/roles\/(\d+)$/.exec(p);
    if (m && method === "PATCH") {
      const r = s.roles.find((x) => x.id === m[1]);
      Object.assign(r, body);
      return r;
    }
    m = /^\/guilds\/\d+\/members\/(\d+)$/.exec(p);
    if (m && method === "GET")
      return s.members[m[1]] ? { user: { id: m[1] }, roles: s.members[m[1]].roles } : err(404, "Unknown Member");
    m = /^\/guilds\/\d+\/members\/(\d+)\/roles\/(\d+)$/.exec(p);
    if (m && method === "PUT") {
      s.members[m[1]].roles.push(m[2]);
      return null;
    }
    if (/^\/guilds\/\d+\/channels$/.test(p)) {
      if (method === "GET") return s.channels;
      if (method === "POST") {
        if ((body.type === 5 || body.type === 15) && !s.guild.features.includes("COMMUNITY"))
          return err(400, "This channel type needs the Community feature");
        const c = { id: id(), position: s.channels.length, parent_id: null, permission_overwrites: [], ...body };
        s.channels.push(c);
        return c;
      }
      if (method === "PATCH") {
        for (const x of body) Object.assign(chan(x.id), x);
        return null;
      }
    }
    m = /^\/channels\/(\d+)$/.exec(p);
    if (m) {
      const c = chan(m[1]);
      if (!c) return err(404, "Unknown Channel");
      if (method === "PATCH") {
        if (body.type === 5 && !s.guild.features.includes("COMMUNITY")) return err(400, "Needs Community");
        Object.assign(c, body);
        if ("locked" in body || "archived" in body)
          c.thread_metadata = { ...(c.thread_metadata ?? {}), locked: body.locked, archived: body.archived ?? false };
        return c;
      }
      if (method === "DELETE") {
        s.channels = s.channels.filter((x) => x.id !== m[1]);
        return c;
      }
    }
    if (/^\/guilds\/\d+\/auto-moderation\/rules$/.test(p)) {
      if (method === "GET") return s.automod;
      if (method === "POST") {
        const r = { id: id(), ...body };
        s.automod.push(r);
        return r;
      }
    }
    m = /^\/guilds\/\d+\/auto-moderation\/rules\/(\d+)$/.exec(p);
    if (m && method === "PATCH") {
      const r = s.automod.find((x) => x.id === m[1]);
      Object.assign(r, body);
      return r;
    }
    m = /^\/channels\/(\d+)\/messages$/.exec(p);
    if (m) {
      s.messages[m[1]] ??= [];
      const list = s.messages[m[1]];
      if (method === "GET") return [...list].reverse();
      if (method === "POST") {
        const msg = { id: id(), channel_id: m[1], author: { id: BOT_ID }, ...body };
        list.push(msg);
        return msg;
      }
    }
    m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(p);
    if (m) {
      s.messages[m[1]] ??= [];
      const list = s.messages[m[1]];
      const msg = list.find((x) => x.id === m[2]);
      if (!msg) return err(404, "Unknown Message");
      if (method === "GET") return msg;
      if (method === "PATCH") return Object.assign(msg, body);
      if (method === "DELETE") {
        s.messages[m[1]] = list.filter((x) => x.id !== m[2]);
        return null;
      }
    }
    if (/^\/channels\/\d+\/messages\/\d+\/crosspost$/.test(p)) return {};
    if (/^\/guilds\/\d+\/threads\/active$/.test(p)) return { threads: s.threads };
    if (/^\/channels\/\d+\/threads\/archived\/public$/.test(p)) return { threads: [] };
    m = /^\/channels\/(\d+)\/threads$/.exec(p);
    if (m && method === "POST") {
      const t = {
        id: id(),
        parent_id: m[1],
        name: body.name,
        owner_id: BOT_ID,
        flags: 0,
        thread_metadata: { archived: false },
      };
      s.threads.push(t);
      s.messages[t.id] = [{ id: t.id, channel_id: t.id, author: { id: BOT_ID }, ...body.message }];
      return t;
    }
    if (/^\/guilds\/\d+\/onboarding$/.test(p)) {
      if (!s.guild.features.includes("COMMUNITY")) return err(403, "Needs Community");
      if (method === "GET") return s.onboarding;
      if (method === "PUT") {
        if (body.default_channel_ids.length < 7) return err(400, "needs 7 default channels");
        s.onboarding = body;
        return body;
      }
    }
    if (/^\/guilds\/\d+\/welcome-screen$/.test(p)) {
      if (method === "GET") return s.welcome ?? err(404, "Unknown Welcome Screen");
      if (method === "PATCH") {
        s.welcome = body;
        return body;
      }
    }
    if (/^\/guilds\/\d+\/invites$/.test(p)) return s.invites;
    m = /^\/channels\/(\d+)\/invites$/.exec(p);
    if (m) {
      const inv = { code: "KalCodeHQ", channel: { id: m[1] }, max_age: body.max_age, max_uses: body.max_uses };
      s.invites.push(inv);
      return inv;
    }
    m = /^\/channels\/(\d+)\/webhooks$/.exec(p);
    if (m) {
      if (method === "GET") return s.webhooks.filter((w) => w.channel_id === m[1]);
      const w = { id: id(), channel_id: m[1], name: body.name, token: `wh${seq}secret` };
      s.webhooks.push(w);
      return w;
    }
    return err(404, `fake: no route for ${method} ${p}`);
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    s.requests.push({ method, path: u.pathname, headers: init.headers, body });
    const out = route(method, u.pathname, body);
    const isErr = out && typeof out === "object" && "status" in out && "body" in out && Object.keys(out).length === 2;
    const status = isErr ? out.status : out === null ? 204 : 200;
    const payload = isErr ? out.body : out;
    return new Response(status === 204 ? null : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  return { state: s, fetchImpl, botId: BOT_ID };
}
