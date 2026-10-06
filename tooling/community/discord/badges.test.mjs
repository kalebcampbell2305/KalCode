// Badges: the earning rules, the artwork, and recognition end to end against the in-memory Discord.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyServer } from "./apply.mjs";
import { badgeSvg, renderBadge } from "./badges.mjs";
import { createClient } from "./discord-api.mjs";
import { createFakeDiscord, FAKE_TOKEN } from "./fake-discord.mjs";
import { announceHeld, decideAwards, recognize, shoutPayload, snowflakeDay } from "./recognize.mjs";
import * as S from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const badge = (key) => S.BADGES.find((b) => b.key === key);
const roleIds = Object.fromEntries(S.ROLES.map((r, i) => [r.key, `r${i}`]));
const now = new Date("2026-12-01T00:00:00Z");
const member = (id, extra = {}) => ({ id, bot: false, joinedAt: "2026-10-05T00:00:00Z", roles: [], ...extra });
const days = (n) => Array.from({ length: n }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
const decide = (input) =>
  decideAwards({ members: [], activeDays: {}, threads: [], featured: [], roleIds, now, ...input }).map(
    (a) => `${a.userId}:${a.badge.key}`,
  );

describe("earning rules", () => {
  it("Bug Hunter and Idea Shipped follow the team's forum tags", () => {
    const members = [member("a"), member("b"), member("c")];
    const threads = [
      { forum: "bugs", ownerId: "a", title: "Crash on launch", tags: ["Windows", "Confirmed"], authors: ["a"] },
      { forum: "bugs", ownerId: "b", title: "Maybe a bug", tags: ["macOS"], authors: ["b"] },
      { forum: "features", ownerId: "c", title: "Dark mode", tags: ["Shipped"], authors: ["c"] },
    ];
    const got = decide({ members, threads }).filter((x) => !x.endsWith(":early"));
    assert.deepEqual(got.sort(), ["a:bughunter", "c:shipped"]);
  });

  it("Helper needs 3 resolved posts, and never goes to the asker or the team", () => {
    const resolved = (owner, authors) => ({
      forum: "support",
      ownerId: owner,
      title: "q",
      tags: ["Resolved"],
      authors,
    });
    const members = [member("asker"), member("h"), member("almost"), member("mod", { roles: [roleIds.moderator] })];
    const threads = [
      resolved("asker", ["asker", "h", "almost", "mod"]),
      resolved("asker", ["asker", "h", "almost", "mod"]),
      resolved("asker", ["asker", "h", "mod"]),
      { forum: "support", ownerId: "asker", title: "open", tags: [], authors: ["almost"] },
    ];
    const got = decide({ members, threads }).filter((x) => x.includes(":helper"));
    assert.deepEqual(got, ["h:helper"]);
  });

  it("the activity ladder counts distinct active days, and Veteran also needs 90 days of membership", () => {
    const members = [
      member("reg"),
      member("vet", { joinedAt: "2026-08-01T00:00:00Z" }),
      member("newbie30", { joinedAt: "2026-11-20T00:00:00Z" }),
      member("quiet"),
    ];
    const activeDays = { reg: days(7), vet: days(30), newbie30: days(30), quiet: [...days(3), ...days(3)] };
    const got = decide({ members, activeDays }).filter((x) => /:(regular|veteran)$/.test(x));
    assert.deepEqual(got.sort(), ["newbie30:regular", "reg:regular", "vet:regular", "vet:veteran"]);
  });

  it("Showcase goes to the author of a post the team starred; Early Adopter by join date", () => {
    const members = [member("maker"), member("late", { joinedAt: "2027-02-01T00:00:00Z" })];
    const got = decide({ members, featured: [{ messageId: "1", authorId: "maker" }] });
    assert.deepEqual(got.sort(), ["maker:early", "maker:showcase"]);
  });

  it("never re-awards a badge a member holds, and never awards bots", () => {
    const members = [member("a", { roles: [roleIds.bughunter] }), member("bot", { bot: true })];
    const threads = [
      { forum: "bugs", ownerId: "a", title: "x", tags: ["Confirmed"], authors: [] },
      { forum: "bugs", ownerId: "bot", title: "y", tags: ["Confirmed"], authors: [] },
    ];
    assert.deepEqual(
      decide({ members, threads }).filter((x) => !x.endsWith(":early")),
      [],
    );
  });

  it("announces hand-granted badges once, and Early Adopter never", () => {
    const m = [member("c", { roles: [roleIds.contributor, roleIds.early] })];
    assert.deepEqual(
      announceHeld({ members: m, roleIds, announced: {} }).map((a) => a.badge.key),
      ["contributor"],
    );
    assert.deepEqual(announceHeld({ members: m, roleIds, announced: { c: ["contributor"] } }), []);
  });

  it("reads the day a message was sent from its id", () => {
    const id = String((BigInt(Date.parse("2026-10-05T15:00:00Z")) - 1420070400000n) << 22n);
    assert.equal(snowflakeDay(id), "2026-10-05");
  });

  it("shout-outs mention only the member who earned the badge", () => {
    const p = shoutPayload(
      { userId: "42", badge: badge("bughunter"), reason: { title: "Crash on launch" } },
      { channelIds: { showcase: "7" }, emojiIds: { bughunter: "99" } },
    );
    assert.deepEqual(p.allowed_mentions, { users: ["42"], parse: [] });
    assert.match(p.content, /^<:kc_bughunter:99> Congrats <@42>!$/);
    assert.match(p.embeds[0].description, /<@42> reported "Crash on launch", and the team confirmed it/);
    assert.equal(p.embeds[0].thumbnail.url, "https://cdn.discordapp.com/emojis/99.png?size=128");
  });
});

describe("badge artwork", () => {
  it("renders every badge as a small 256 px PNG with its own accent", () => {
    const accents = new Set();
    for (const b of S.BADGES) {
      const png = renderBadge(b, 256);
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      assert.equal(png.readUInt32BE(16), 256);
      assert.ok(png.length < 256 * 1024, `${b.key} must stay under Discord's 256 KB role-icon limit`);
      assert.match(badgeSvg(b), new RegExp(b.accent));
      accents.add(`${b.glyph}`);
    }
    assert.equal(accents.size, S.BADGES.length, "every badge has its own glyph");
    assert.throws(() => badgeSvg({ ...S.BADGES[0], glyph: "nope" }), /unknown glyph/);
  });

  it("every badge has a role, a rule and a description", () => {
    for (const b of S.BADGES) {
      assert.ok(
        S.ROLES.some((r) => r.key === b.role),
        b.key,
      );
      assert.ok(b.how.length > 10 && b.how.length < 100, b.key);
      assert.equal(typeof b.shout({}), "string");
    }
  });
});

describe("recognize (end to end)", () => {
  const snow = (iso, n = 0) => String(((BigInt(Date.parse(iso)) - 1420070400000n) << 22n) + BigInt(n));
  const setup = async () => {
    const fake = createFakeDiscord();
    const api = createClient({ token: FAKE_TOKEN, fetchImpl: fake.fetchImpl });
    await applyServer({ api, repoRoot, log: () => {}, state: {}, changelogIds: [] });
    const s = fake.state;
    const ch = (name) => s.channels.find((c) => c.name === name);
    s.members.alice = { roles: [], joined_at: "2026-10-05T00:00:00Z" };
    s.members.bob = { roles: [], joined_at: "2026-10-06T00:00:00Z" };
    // Alice talks in #general on 7 different days.
    s.messages[ch("general").id] = days(7).map((d, i) => ({
      id: snow(`${d}T12:00:00Z`, i),
      type: 0,
      author: { id: "alice" },
    }));
    // Bob's bug report is confirmed by the team.
    const bugs = ch("bug-reports");
    const confirmed = bugs.available_tags.find((t) => t.name === "Confirmed").id;
    s.threads.push({
      id: snow("2026-10-07T00:00:00Z", 1),
      parent_id: bugs.id,
      name: "Crash on launch",
      owner_id: "bob",
      applied_tags: [confirmed],
      flags: 0,
    });
    return { fake, api, s, ch };
  };

  it("grants earned badges, posts shout-outs, and is quiet on the next run", async () => {
    const { s, api, ch } = await setup();
    const ledger = {};
    const first = await recognize({ api, ledger, now });
    const roleOf = (name) => s.roles.find((r) => r.name === name).id;
    assert.ok(s.members.alice.roles.includes(roleOf("Regular")));
    assert.ok(s.members.bob.roles.includes(roleOf("Bug Hunter")));
    assert.ok(s.members.alice.roles.includes(roleOf("Early Adopter")), "joined in the 0.1 era");
    assert.ok(!s.members.bob.roles.includes(roleOf("Regular")));
    const shouts = s.messages[ch("general").id].filter((m) => m.author.bot);
    assert.deepEqual(shouts.map((m) => m.embeds[0].title).sort(), ["New badge: Bug Hunter", "New badge: Regular"]);
    assert.ok(shouts.every((m) => m.allowed_mentions.parse.length === 0 && m.allowed_mentions.users.length === 1));
    assert.ok(
      shouts.every((m) => m.embeds[0].thumbnail?.url.includes("/emojis/")),
      "badge emoji as artwork",
    );
    assert.equal(first.granted.length, 5); // Regular, Bug Hunter, and Early Adopter for alice, bob and the owner

    const before = s.requests.length;
    const second = await recognize({ api, ledger, now });
    assert.deepEqual(second.granted, []);
    assert.deepEqual(second.shouted, []);
    assert.ok(!s.requests.slice(before).some((r) => r.method !== "GET"), "nothing written on a quiet run");
  });

  it("takes stock on the first run, then announces badges the team grants by hand", async () => {
    const { s, api, ch } = await setup();
    const contributor = s.roles.find((r) => r.name === "Contributor").id;
    s.members.alice.roles.push(contributor);
    const ledger = {};
    const first = await recognize({ api, ledger, now });
    assert.ok(
      !first.shouted.some((x) => x.badge === "contributor"),
      "held before the first run: recorded, not announced",
    );
    s.members.bob.roles.push(contributor);
    const second = await recognize({ api, ledger, now });
    assert.deepEqual(second.shouted, [{ userId: "bob", badge: "contributor" }]);
    assert.ok(s.messages[ch("general").id].some((m) => m.embeds?.[0]?.title === "New badge: Contributor"));
  });

  it("features showcase posts only when a team member stars them", async () => {
    const { s, api } = await setup();
    s.members.carol = { roles: [] };
    const mod = s.roles.find((r) => r.name === "Moderator").id;
    s.members.mo = { roles: [mod] };
    const sc = s.channels.find((c) => c.name === "showcase").id;
    s.messages[sc] = [
      {
        id: snow("2026-10-08T00:00:00Z", 1),
        type: 0,
        author: { id: "carol" },
        reactions: [{ emoji: { name: "⭐" }, count: 1 }],
      },
      {
        id: snow("2026-10-08T00:00:00Z", 2),
        type: 0,
        author: { id: "bob" },
        reactions: [{ emoji: { name: "⭐" }, count: 1 }],
      },
    ];
    s.reactions[`${s.messages[sc][0].id}:⭐`] = ["mo"];
    s.reactions[`${s.messages[sc][1].id}:⭐`] = ["alice"]; // a regular member's star doesn't count
    const report = await recognize({ api, ledger: {}, now });
    const showcase = s.roles.find((r) => r.name === "Showcase").id;
    assert.ok(s.members.carol.roles.includes(showcase));
    assert.ok(!s.members.bob.roles.includes(showcase));
    assert.ok(report.granted.some((g) => g.userId === "carol" && g.badge === "showcase"));
  });

  it("works without the Server Members Intent, and says how to turn it on", async () => {
    const { s, api } = await setup();
    s.membersIntent = false;
    const report = await recognize({ api, ledger: {}, now });
    assert.ok(report.warnings.some((w) => w.includes("Server Members Intent")));
    assert.ok(
      s.members.bob.roles.includes(s.roles.find((r) => r.name === "Bug Hunter").id),
      "people seen acting still earn",
    );
  });

  it("never re-grants a badge a person removed", async () => {
    const { s, api } = await setup();
    const ledger = {};
    await recognize({ api, ledger, now });
    const regular = s.roles.find((r) => r.name === "Regular").id;
    assert.ok(s.members.alice.roles.includes(regular));
    s.members.alice.roles = s.members.alice.roles.filter((r) => r !== regular); // removed by the team
    const again = await recognize({ api, ledger, now });
    assert.ok(!s.members.alice.roles.includes(regular), "the removal stands");
    assert.ok(!again.granted.some((g) => g.userId === "alice" && g.badge === "regular"));
  });

  it("plans without writing", async () => {
    const { s, api } = await setup();
    const before = s.requests.length;
    const report = await recognize({ api, ledger: {}, now, dryRun: true });
    assert.ok(report.granted.length > 0);
    assert.ok(!s.requests.slice(before).some((r) => r.method !== "GET"));
  });

  it("caps shout-outs per run and lets the rest follow on later runs", async () => {
    const { s, api, ch } = await setup();
    const general = ch("general").id;
    for (let u = 0; u < 12; u++) {
      s.members[`u${u}`] = { roles: [], joined_at: "2026-10-05T00:00:00Z" };
      for (const [i, d] of days(7).entries())
        s.messages[general].push({ id: snow(`${d}T13:00:00Z`, 100 + u * 10 + i), type: 0, author: { id: `u${u}` } });
    }
    const ledger = {};
    const first = await recognize({ api, ledger, now });
    assert.equal(first.shouted.length, S.RECOGNITION.maxShoutsPerRun);
    const second = await recognize({ api, ledger, now });
    assert.ok(second.shouted.length > 0, "the overflow is announced on the next run");
  });
});
