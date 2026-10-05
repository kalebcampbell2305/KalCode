// The KalCode Discord, declared once. `kc-discord.mjs apply` makes the live server match this file
// (idempotently: it adopts what exists by name, creates what is missing, and never deletes anything it
// does not own). Change the server by changing this file, then run `plan` and `apply`.
//
// Community standard (AGENTS.md "Permanent community standard"): simple, beautiful, professional,
// high-signal, safe, easy to navigate. Add a channel only when activity justifies it.

/** The KalCode server (from the public invite discord.gg/7pKTysuC8). */
export const GUILD_ID = "1554995816639369348";
/** The server owner (gets the decorative Owner role). */
export const OWNER_USER_ID = "1541801222867255346";

export const SITE = "https://kalcoded.com";
export const LINKS = {
  site: SITE,
  download: `${SITE}/download`,
  updates: `${SITE}/updates`,
  pricing: `${SITE}/pricing`,
  docs: `${SITE}/docs`,
  x: "https://x.com/KalCodeDev",
};

/**
 * Things the public site says are unavailable right now. Community posts never present them as working:
 * the changelog drops or rewrites any line that names them. Remove an entry when kalcoded.com does.
 */
export const PUBLICLY_UNAVAILABLE = ["Gemini CLI"];

/** Electric blue (packages/ui tokens `--accent`), used for every embed. */
export const EMBED_COLOR = 0x4c8dff;

// ── Permissions ────────────────────────────────────────────────────────────────────────────────

const bit = (n) => 1n << BigInt(n);
export const P = {
  CREATE_INSTANT_INVITE: bit(0),
  KICK_MEMBERS: bit(1),
  BAN_MEMBERS: bit(2),
  ADMINISTRATOR: bit(3),
  MANAGE_CHANNELS: bit(4),
  MANAGE_GUILD: bit(5),
  ADD_REACTIONS: bit(6),
  VIEW_AUDIT_LOG: bit(7),
  STREAM: bit(9),
  VIEW_CHANNEL: bit(10),
  SEND_MESSAGES: bit(11),
  MANAGE_MESSAGES: bit(13),
  EMBED_LINKS: bit(14),
  ATTACH_FILES: bit(15),
  READ_MESSAGE_HISTORY: bit(16),
  MENTION_EVERYONE: bit(17),
  USE_EXTERNAL_EMOJIS: bit(18),
  CONNECT: bit(20),
  SPEAK: bit(21),
  MUTE_MEMBERS: bit(22),
  MOVE_MEMBERS: bit(24),
  USE_VAD: bit(25),
  CHANGE_NICKNAME: bit(26),
  MANAGE_NICKNAMES: bit(27),
  MANAGE_ROLES: bit(28),
  MANAGE_WEBHOOKS: bit(29),
  USE_APPLICATION_COMMANDS: bit(31),
  MANAGE_EVENTS: bit(33),
  MANAGE_THREADS: bit(34),
  CREATE_PUBLIC_THREADS: bit(35),
  CREATE_PRIVATE_THREADS: bit(36),
  SEND_MESSAGES_IN_THREADS: bit(38),
  MODERATE_MEMBERS: bit(40),
  CREATE_EVENTS: bit(44),
  SEND_VOICE_MESSAGES: bit(46),
  SEND_POLLS: bit(49),
};
export const perms = (...flags) => flags.reduce((a, b) => a | b, 0n);

/** What every member can do by default. No @everyone mentions, no webhooks, no moderation. */
export const EVERYONE_PERMISSIONS = perms(
  P.CREATE_INSTANT_INVITE,
  P.ADD_REACTIONS,
  P.STREAM,
  P.VIEW_CHANNEL,
  P.SEND_MESSAGES,
  P.EMBED_LINKS,
  P.ATTACH_FILES,
  P.READ_MESSAGE_HISTORY,
  P.USE_EXTERNAL_EMOJIS,
  P.CONNECT,
  P.SPEAK,
  P.USE_VAD,
  P.CHANGE_NICKNAME,
  P.USE_APPLICATION_COMMANDS,
  P.CREATE_PUBLIC_THREADS,
  P.SEND_MESSAGES_IN_THREADS,
  P.SEND_VOICE_MESSAGES,
  P.SEND_POLLS,
);

const MODERATION = perms(
  P.KICK_MEMBERS,
  P.VIEW_AUDIT_LOG,
  P.MANAGE_MESSAGES,
  P.MANAGE_NICKNAMES,
  P.MANAGE_THREADS,
  P.MODERATE_MEMBERS,
  P.MUTE_MEMBERS,
  P.MOVE_MEMBERS,
);

// ── Roles (top to bottom) ──────────────────────────────────────────────────────────────────────
// A restrained graphite/electric-blue ladder; no rainbow. Plan roles (Free, Pro, Max, Max 2X) are
// deliberately absent: they may only ever be assigned by server-side entitlement verification
// (see README "KalCode account linking"), never by hand.

export const ROLES = [
  { key: "owner", name: "Owner", color: 0xf2f6fc, hoist: true, mentionable: false, permissions: 0n },
  {
    key: "team",
    name: "KalCode Team",
    color: 0x4c8dff,
    hoist: true,
    mentionable: false,
    permissions: perms(MODERATION, P.BAN_MEMBERS, P.MENTION_EVERYONE, P.MANAGE_EVENTS, P.CREATE_EVENTS),
  },
  { key: "moderator", name: "Moderator", color: 0x6fa2ff, hoist: true, mentionable: true, permissions: MODERATION },
  { key: "contributor", name: "Contributor", color: 0x8db6ff, hoist: false, mentionable: false, permissions: 0n },
  { key: "early", name: "Early Adopter", color: 0xb7cdf2, hoist: false, mentionable: false, permissions: 0n },
  { key: "member", name: "Member", color: 0, hoist: false, mentionable: false, permissions: 0n },
];
/** Roles that may see the staff category and are exempt from community AutoMod limits. */
export const STAFF_ROLES = ["owner", "team", "moderator"];

// ── Channels ───────────────────────────────────────────────────────────────────────────────────
// type: text | announcement | forum | voice. `readOnly` channels are posted to by the team and the
// KalCode bot only. `staff` categories are invisible to everyone else.

const SAFETY_LINE =
  "Never post passwords, API keys, provider tokens or private code. KalCode staff will never ask for them.";

export const FORUMS = {
  support: {
    guidelines: [
      "Ask anything about using KalCode. One question per post.",
      "",
      "Before posting:",
      "• Update to the latest version (Settings › Updates)",
      "• Say what you tried and what happened",
      "• Mention Windows or macOS, and the provider if relevant",
      "• Add a screenshot if it helps",
      "",
      SAFETY_LINE,
      "",
      "Mark your post Resolved when it's answered.",
    ].join("\n"),
    tags: [
      { name: "Windows" },
      { name: "macOS" },
      { name: "Claude Code" },
      { name: "Codex" },
      { name: "Cursor" },
      { name: "Account & plans" },
      { name: "Resolved" },
    ],
    reaction: null,
  },
  bugs: {
    guidelines: [
      "One bug per post. Search first; if it's already reported, add your details there.",
      "",
      "WHAT HAPPENED?",
      "WHAT DID YOU EXPECT?",
      "KALCODE VERSION (Settings › About)",
      "WINDOWS / MAC",
      "PROVIDER (if relevant)",
      "STEPS TO REPRODUCE",
      "SCREENSHOT / VIDEO (if available)",
      "",
      SAFETY_LINE,
    ].join("\n"),
    tags: [
      { name: "Windows" },
      { name: "macOS" },
      { name: "Claude Code" },
      { name: "Codex" },
      { name: "Cursor" },
      { name: "Needs info", moderated: true },
      { name: "Confirmed", moderated: true },
      { name: "Fixed", moderated: true },
    ],
    reaction: null,
  },
  features: {
    guidelines: [
      "One idea per post. Search first and upvote 👍 the ideas you want; the most-requested rise to the top.",
      "",
      "TITLE",
      "WHAT DO YOU WANT?",
      "WHY WOULD IT HELP?",
      "HOW WOULD YOU EXPECT IT TO WORK?",
    ].join("\n"),
    tags: [
      { name: "Code" },
      { name: "Agents & providers" },
      { name: "KalVoice" },
      { name: "Browser" },
      { name: "Integrations" },
      { name: "Under review", moderated: true },
      { name: "Planned", moderated: true },
      { name: "Shipped", moderated: true },
    ],
    reaction: "👍",
  },
};

export const CATEGORIES = [
  {
    key: "start",
    name: "START HERE",
    channels: [
      {
        key: "welcome",
        name: "welcome",
        type: "text",
        readOnly: true,
        topic: "Start here: what KalCode is, where to download it, and where to get help.",
      },
      {
        key: "rules",
        name: "rules",
        type: "text",
        readOnly: true,
        topic: "Community rules. Short, and enforced.",
      },
      {
        key: "announcements",
        name: "announcements",
        type: "announcement",
        readOnly: true,
        topic: "Major KalCode news only. Follow this channel to get it in your own server.",
      },
      {
        key: "changelog",
        name: "changelog",
        type: "announcement",
        readOnly: true,
        topic: "Every KalCode build that ships: what's new and what's fixed.",
      },
      {
        key: "roadmap",
        name: "roadmap",
        type: "text",
        readOnly: true,
        topic:
          "Available now and coming soon, from the same plan catalog as kalcoded.com. No dates until they're real.",
      },
    ],
  },
  {
    key: "kalcode",
    name: "KALCODE",
    channels: [
      {
        key: "general",
        name: "general",
        type: "text",
        topic: "Talk KalCode: agents, workflows, ideas and everything in between.",
      },
      {
        key: "support",
        name: "help-and-support",
        type: "forum",
        forum: "support",
        topic: FORUMS.support.guidelines,
      },
      {
        key: "features",
        name: "feature-requests",
        type: "forum",
        forum: "features",
        topic: FORUMS.features.guidelines,
      },
      { key: "bugs", name: "bug-reports", type: "forum", forum: "bugs", topic: FORUMS.bugs.guidelines },
      {
        key: "showcase",
        name: "showcase",
        type: "text",
        topic: "Show what you built with KalCode. Screenshots and clips welcome.",
      },
      {
        key: "tips",
        name: "tips-and-workflows",
        type: "text",
        topic: "Workflows, layouts, shortcuts and setups that make KalCode faster for you.",
      },
    ],
  },
  {
    key: "build",
    name: "BUILD WITH KALCODE",
    channels: [
      {
        key: "agents",
        name: "agents-and-providers",
        type: "text",
        topic: "Claude Code, Codex and Cursor agents in KalCode: accounts, models, tools and orchestration.",
      },
      {
        key: "kalvoice",
        name: "kalvoice",
        type: "text",
        topic: "KalVoice: dictation, voice commands and controlling your workspace by voice.",
      },
      {
        key: "integrations",
        name: "integrations",
        type: "text",
        topic: "The Integration Hub: custom APIs, MCP servers and connecting your tools.",
      },
      {
        key: "bip",
        name: "build-in-public",
        type: "text",
        topic: "Share progress on what you're building, in public. KalCode's own progress lands here too.",
      },
    ],
  },
  {
    key: "community",
    name: "COMMUNITY",
    channels: [
      {
        key: "introductions",
        name: "introductions",
        type: "text",
        topic: "Say hello: who you are, what you build, and how you use AI coding agents.",
      },
      { key: "offtopic", name: "off-topic", type: "text", topic: "Anything else. Keep it friendly and safe for work." },
    ],
  },
  {
    key: "voice",
    name: "VOICE",
    channels: [
      { key: "voice_general", name: "General", type: "voice" },
      { key: "voice_cowork", name: "Build Together", type: "voice" },
    ],
  },
  {
    key: "staff",
    name: "STAFF",
    staff: true,
    channels: [
      { key: "staff", name: "staff", type: "text", topic: "Team coordination." },
      { key: "moderation", name: "moderation", type: "text", topic: "Moderation log and Discord community updates." },
      { key: "reports", name: "reports", type: "text", topic: "AutoMod alerts and member reports land here." },
      { key: "notes", name: "internal-notes", type: "text", topic: "Internal notes. Never public." },
    ],
  },
];

/** Every channel spec keyed by its key, with its category. */
export const CHANNELS = Object.fromEntries(
  CATEGORIES.flatMap((c) => c.channels.map((ch) => [ch.key, { ...ch, category: c.key, staff: Boolean(c.staff) }])),
);

/**
 * Leftovers the owner approved removing (2026-10-05): an empty text #feature-requests (Discord can't turn a
 * text channel into a forum), an empty forum and an unnamed empty role. `apply` removes each one only
 * while it is still empty (no messages or posts, no permissions); anything that gained content is kept
 * and reported.
 */
export const LEGACY = {
  channels: [
    { name: "feature-requests", type: "text" },
    { name: "kalcode-discussions", type: "forum" },
  ],
  roles: ["new role"],
};

/** Default categories Discord creates for a new server; removed once they are empty. */
export const DISCORD_DEFAULT_CATEGORIES = ["Text Channels", "Voice Channels"];

// ── Server settings ────────────────────────────────────────────────────────────────────────────

export const GUILD_SETTINGS = {
  name: "KalCode",
  description: "The official community for KalCode, the AI engineering workspace. Code the future.",
  verificationLevel: 2, // MEDIUM: verified email and registered for 5+ minutes
  explicitContentFilter: 2, // scan media from all members
  defaultMessageNotifications: 1, // only @mentions
  preferredLocale: "en-US",
  systemChannel: "introductions",
  // Suppress boost and setup-tip system messages; keep join messages (they make #introductions alive).
  systemChannelFlags: (1 << 1) | (1 << 2),
  rulesChannel: "rules",
  publicUpdatesChannel: "moderation",
  safetyAlertsChannel: "reports",
  icon: "assets/branding/discord/kalcode-discord-icon-512.png",
  banner: "assets/branding/discord/kalcode-discord-banner-960x540.png", // needs boost level 2
  splash: "assets/branding/discord/kalcode-discord-splash-1920x1080.png", // needs boost level 1
};

// ── AutoMod ────────────────────────────────────────────────────────────────────────────────────
// Discord AutoMod regexes use Rust syntax (no look-around). Every pattern here also compiles in JS
// and is exercised by community.test.mjs.

export const SECRET_PATTERNS = [
  "\\bsk-ant-[A-Za-z0-9_-]{20,}", // Anthropic API keys
  "\\bsk-(proj-)?[A-Za-z0-9_-]{40,}", // OpenAI API keys
  "\\bgh[pousr]_[A-Za-z0-9]{36,}", // GitHub tokens
  "\\bgithub_pat_[A-Za-z0-9_]{60,}", // GitHub fine-grained tokens
  "\\bxox[abprs]-[A-Za-z0-9-]{10,}", // Slack tokens
  "\\bAKIA[0-9A-Z]{16}\\b", // AWS access key ids
  "\\bAIza[0-9A-Za-z_-]{35}", // Google API keys
  "\\b(sk|rk)_live_[0-9a-zA-Z]{24,}", // Stripe live keys
  "-----BEGIN [A-Z ]*PRIVATE KEY-----", // PEM private keys
  "\\b[MNO][A-Za-z0-9_-]{23,27}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,}", // Discord bot tokens
];

export const SCAM_KEYWORDS = [
  "*free nitro*",
  "*nitro for free*",
  "*steam gift*",
  "*claim your reward*",
  "*claim your airdrop*",
  "*double your crypto*",
  "*grabify*",
  "*iplogger*",
  "*2no.co*",
  "*steamcommunlty*",
  "*steamcomunity*",
  "*stearncommunity*",
];
export const SCAM_PATTERNS = [
  "(d[il1]sc[o0]rd|discorcl)[-.]?(gift|nitro)s?\\.[a-z]{2,10}", // fake Discord gift domains (the real one is discord.gift)
  "(d[l1]sc[o0]rd|disc0rd|discorcl)(app)?\\.(com|gg)", // look-alike Discord domains
];

export const IMPERSONATION_KEYWORDS = [
  "*kalcode team*",
  "*kalcode support*",
  "*kalcode staff*",
  "*kalcode admin*",
  "*kalcode official*",
  "*kalcode mod*",
];

/** Rules, matched by name. `alert` routes to #reports. */
export const AUTOMOD_RULES = [
  { name: "Block spam", trigger: "spam", block: "Blocked as likely spam.", alert: true, exemptStaff: true },
  {
    name: "Block mention spam",
    trigger: "mention_spam",
    mentionLimit: 5,
    block: "Too many mentions in one message.",
    alert: true,
    timeoutSeconds: 600,
    exemptStaff: true,
  },
  {
    name: "Block hate and sexual content",
    trigger: "keyword_preset",
    presets: [2, 3], // SEXUAL_CONTENT, SLURS
    block: "This message breaks the community rules.",
    alert: true,
  },
  {
    name: "Block scams and malicious links",
    trigger: "keyword",
    keywords: SCAM_KEYWORDS,
    regex: SCAM_PATTERNS,
    block: "Blocked: this looks like a scam or a malicious link.",
    alert: true,
    exemptStaff: true,
  },
  {
    name: "Protect secrets and tokens",
    trigger: "keyword",
    regex: SECRET_PATTERNS,
    block: "That looks like a secret (key, token or private key). Blocked to protect you. Revoke it if it was real.",
    alert: true,
  },
  {
    name: "Block staff impersonation",
    trigger: "member_profile",
    keywords: IMPERSONATION_KEYWORDS,
    exemptStaff: true,
  },
];

// ── Onboarding ─────────────────────────────────────────────────────────────────────────────────

export const ONBOARDING = {
  defaultChannels: [
    "welcome",
    "rules",
    "announcements",
    "changelog",
    "roadmap",
    "general",
    "support",
    "features",
    "bugs",
    "showcase",
    "introductions",
  ],
  prompts: [
    {
      title: "What brings you to KalCode?",
      singleSelect: true,
      required: true,
      options: [
        {
          title: "I use KalCode",
          description: "Get help, share workflows and shape what's next",
          roles: ["member"],
          channels: ["tips", "agents"],
        },
        {
          title: "I'm trying KalCode",
          description: "Get started and ask anything",
          roles: ["member"],
          channels: ["tips"],
        },
        {
          title: "I'm following along",
          description: "Updates, the roadmap and build-in-public",
          roles: ["member"],
          channels: ["bip"],
        },
      ],
    },
    {
      title: "What do you want to follow?",
      singleSelect: false,
      required: false,
      options: [
        { title: "Agents & providers", description: "Claude Code, Codex and Cursor in KalCode", channels: ["agents"] },
        { title: "KalVoice", description: "Voice control of your workspace", channels: ["kalvoice"] },
        { title: "Integrations", description: "APIs, MCP servers and the Integration Hub", channels: ["integrations"] },
        { title: "Build in public", description: "Progress from KalCode and the community", channels: ["bip"] },
        { title: "Off-topic", description: "Everything else", channels: ["offtopic"] },
      ],
    },
  ],
};

export const WELCOME_SCREEN = {
  description: "The official community for KalCode, the AI engineering workspace. Code the future.",
  channels: [
    { channel: "support", description: "Get help with KalCode" },
    { channel: "bugs", description: "Report a bug" },
    { channel: "features", description: "Suggest a feature and vote" },
    { channel: "changelog", description: "See what's new" },
    { channel: "general", description: "Say hello" },
  ],
};

/** The permanent invite created on #welcome (the shared invite expires). */
export const INVITE = { channel: "welcome", maxAge: 0, maxUses: 0 };

/** Webhooks created for release automation; their URLs are stored locally, never printed or committed. */
export const WEBHOOKS = [
  { key: "changelog", channel: "changelog", name: "KalCode Changelog" },
  { key: "announcements", channel: "announcements", name: "KalCode" },
];

/**
 * Roadmap items currently in development, by `PLAN_FEATURE_GROUPS` feature id. The plan catalog only
 * knows "available" and "coming soon", so this list is owner-maintained; an empty list omits the
 * IN DEVELOPMENT section rather than guessing.
 */
export const IN_DEVELOPMENT = [];
