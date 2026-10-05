// The messages the KalCode bot keeps in the server. Each is identified by its channel and embed title,
// so `apply` edits the existing message instead of posting a duplicate. Channel mentions use
// `{#key}` placeholders that `apply` resolves to real channel ids.
import { BADGES, EMBED_COLOR, LINKS, ROLES } from "./server.mjs";

export const SIGNOFF = "Refactor the workflow. Code the future.";

const embed = (e) => ({ color: EMBED_COLOR, ...e });

/** Pinned-style messages: one per key. */
export const MESSAGES = [
  {
    key: "welcome",
    channel: "welcome",
    embeds: [
      embed({
        title: "Welcome to KalCode",
        description: [
          "KalCode is an AI engineering workspace for running coding agents, providers, terminals, Browser, KalVoice and engineering workflows in one place.",
          "",
          `**${SIGNOFF}**`,
        ].join("\n"),
        image: { url: `${LINKS.site}/og.png` },
        fields: [
          { name: "Get KalCode", value: `[Download for Windows and macOS](${LINKS.download})`, inline: true },
          { name: "What's new", value: "{#changelog} · {#announcements}", inline: true },
          { name: "Roadmap", value: "{#roadmap}", inline: true },
          { name: "Need help?", value: "{#support}", inline: true },
          { name: "Found a bug?", value: "{#bugs}", inline: true },
          { name: "Have an idea?", value: "{#features}", inline: true },
          { name: "Before you post", value: "Read {#rules}. Then say hello in {#introductions}.", inline: false },
        ],
        footer: { text: `kalcoded.com · ${SIGNOFF}` },
      }),
    ],
  },
  {
    key: "rules",
    channel: "rules",
    embeds: [
      embed({
        title: "Community rules",
        description: [
          "**1. Be respectful.** No harassment, hate, slurs or personal attacks.",
          "**2. Keep it safe for work.** No NSFW content.",
          "**3. No spam or scams.** No unsolicited ads, mass mentions or fake giveaways. Share your own work in {#showcase}.",
          "**4. No piracy or malware.** No cracks, stolen accounts, exploits or malicious links.",
          "**5. Never share credentials.** Passwords, API keys, provider tokens and private keys stay private. KalCode staff will never ask for them.",
          "**6. Don't impersonate** KalCode staff or anyone else.",
          "**7. Use the right place.** Questions in {#support}, bugs in {#bugs}, ideas in {#features}.",
          "**8. Follow** Discord's [Terms](https://discord.com/terms) and [Community Guidelines](https://discord.com/guidelines).",
          "",
          "Moderators may remove content or members that break these rules. To report something, right-click the message › Apps › Report, or mention @Moderator.",
        ].join("\n"),
        footer: { text: SIGNOFF },
      }),
    ],
  },
  {
    key: "announcement-discord-open",
    channel: "announcements",
    embeds: [
      embed({
        title: "The KalCode Discord is open",
        description: [
          "Welcome. This is the official home for the KalCode community: people shipping with AI coding agents.",
          "",
          "• **Get help** from the team in {#support}",
          "• **Report bugs** in {#bugs}",
          "• **Request features and vote** on what's next in {#features}",
          "• **See every build** the day it ships in {#changelog}",
          "• **What's available and what's coming** in {#roadmap}",
          "",
          "New here? Start in {#welcome}, then say hello in {#introductions}.",
          "",
          "Bring your team: https://discord.gg/BJMFjm3ZbS",
        ].join("\n"),
        image: { url: `${LINKS.site}/og.png` },
        footer: { text: SIGNOFF },
      }),
    ],
  },
  {
    key: "announcement-019",
    channel: "announcements",
    embeds: [
      embed({
        title: "KalCode 0.1.9 is here",
        url: LINKS.updates,
        description: [
          "Live Browser in Code, Cursor as a native provider, native agent tools, the Integration Hub and one agent state everywhere.",
          "",
          "**New in 0.1.9**",
          "• **Live Browser.** See the errors, pick the element, send it all to your coding agent.",
          "• **Cursor** joins Claude Code and Codex as a native coding provider.",
          "• **Native agent tools.** Web search, MCP servers and shell, working inside KalCode.",
          "• **Integration Hub.** Connect your APIs and MCP servers; sensitive actions wait for your one-time approval.",
          "• **Terminal Organization**, **New like this**, a universal quick switcher and faster terminals.",
          "",
          `[Download KalCode](${LINKS.download}) · Every build in {#changelog}`,
        ].join("\n"),
        image: { url: `${LINKS.site}/og.png` },
        footer: { text: SIGNOFF },
      }),
    ],
  },
];

/** The badges guide in #welcome, generated from BADGES so it can never drift from the rules. */
const roleName = (key) => ROLES.find((r) => r.key === key).name;
MESSAGES.push({
  key: "badges",
  channel: "welcome",
  embeds: [
    embed({
      title: "Earn badges",
      description: [
        "Badges are earned by making KalCode better, never by message count. They show on your profile, and the team gives you a shout-out in {#general} when you earn one.",
        "",
        ...BADGES.map((b) => `{:${b.key}} **${roleName(b.role)}** · ${b.how}`),
      ].join("\n"),
      footer: { text: SIGNOFF },
    }),
  ],
});

/**
 * A pinned "start here" post in each forum, so the template is one click away and copyable.
 * Discord forums have no native post template; the guidelines (channel topic) plus this post are it.
 */
export const FORUM_GUIDES = [
  {
    key: "support-guide",
    channel: "support",
    title: "Start here: how to get help fast",
    embeds: [
      embed({
        title: "How to get help fast",
        description: [
          "Open a new post with your question. A short, specific post gets the fastest answer.",
          "",
          "**Include**",
          "• What you were trying to do, and what happened instead",
          "• Windows or macOS, and your KalCode version (Settings › About)",
          "• The provider, if it's about an agent (Claude Code, Codex or Cursor)",
          "• A screenshot, if it helps",
          "",
          "**Before posting:** update to the latest version (Settings › Updates).",
          "",
          "**Never post** passwords, API keys, provider tokens or private code. KalCode staff will never ask for them.",
          "",
          "Found a real bug? Use {#bugs}. Have an idea? Use {#features}.",
        ].join("\n"),
        footer: { text: SIGNOFF },
      }),
    ],
  },
  {
    key: "bugs-guide",
    channel: "bugs",
    title: "Start here: how to report a bug",
    embeds: [
      embed({
        title: "How to report a bug",
        description: [
          "One bug per post. Search first; if it's already reported, add your details to that post.",
          "Copy this template into your post:",
          "```",
          "WHAT HAPPENED?",
          "",
          "WHAT DID YOU EXPECT?",
          "",
          "KALCODE VERSION (Settings › About):",
          "WINDOWS / MAC:",
          "PROVIDER (if relevant):",
          "",
          "STEPS TO REPRODUCE",
          "1.",
          "2.",
          "3.",
          "```",
          "Attach a screenshot or short video if you can, and tag your platform.",
          "",
          "**Never post** passwords, API keys, provider tokens or private code. Redact them from screenshots and logs.",
        ].join("\n"),
        footer: { text: SIGNOFF },
      }),
    ],
  },
  {
    key: "features-guide",
    channel: "features",
    title: "Start here: how to request a feature",
    embeds: [
      embed({
        title: "How to request a feature",
        description: [
          "One idea per post. Search first and react 👍 to the ideas you want; the most-requested rise to the top.",
          "Copy this template into your post:",
          "```",
          "WHAT DO YOU WANT?",
          "",
          "WHY WOULD IT HELP?",
          "",
          "HOW WOULD YOU EXPECT IT TO WORK?",
          "```",
          "The team tags ideas **Under review**, **Planned** and **Shipped**. Shipped means it's in the KalCode you can download today; see {#roadmap} for what's coming.",
        ].join("\n"),
        footer: { text: SIGNOFF },
      }),
    ],
  },
];

/** Replaces `{#key}` with `<#id>`. Throws on an unknown key so a typo can never ship. */
/** The custom emoji name for a badge (uploaded by `apply`). */
export const badgeEmojiName = (key) => `kc_${key}`;

/**
 * Replaces `{#key}` with `<#channel>` and `{:badge}` with the badge's custom emoji. Throws on an unknown
 * channel so a typo can never ship; an emoji not uploaded yet (a dry run) falls back to nothing.
 */
export function resolveMentions(text, channelIds, emojiIds = {}) {
  return text
    .replace(/\{#([a-z_]+)\}/g, (_, key) => {
      const id = channelIds[key];
      if (!id) throw new Error(`unknown channel placeholder {#${key}}`);
      return `<#${id}>`;
    })
    .replace(/\{:([a-z_]+)\} ?/g, (_, key) => (emojiIds[key] ? `<:${badgeEmojiName(key)}:${emojiIds[key]}> ` : ""));
}

/** Deep-resolves every string in a message payload. */
export function resolvePayload(value, channelIds, emojiIds = {}) {
  if (typeof value === "string") return resolveMentions(value, channelIds, emojiIds);
  if (Array.isArray(value)) return value.map((v) => resolvePayload(v, channelIds, emojiIds));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePayload(v, channelIds, emojiIds)]));
  return value;
}
