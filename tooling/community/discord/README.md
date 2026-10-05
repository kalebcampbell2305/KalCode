# The KalCode Discord, as code

The KalCode community server, `discord.gg/7pKTysuC8` (guild `1554995816639369348`), is declared in this folder. `apply` makes the live server match the declaration.

It follows the community standard in `AGENTS.md`: simple, beautiful, professional, high-signal, safe and easy to navigate.

| File | What it is |
| --- | --- |
| `server.mjs` | The server, declared in one place: roles, categories, channels, forums and their tags/templates, permissions, AutoMod, onboarding, welcome screen, settings |
| `content.mjs` | The bot's standing messages: welcome, rules, the 0.1.9 announcement, and the pinned "start here" guides in each forum |
| `roadmap.mjs` | Generates `#roadmap` from `packages/protocol/src/plans.ts`, the same catalog as kalcoded.com |
| `changelog.mjs` | Turns `docs/releases/<version>+<build>.md` into a `#changelog` post (NEW / FIXED) |
| `apply.mjs` | The idempotent reconciler (see below) |
| `kc-discord.mjs` | The CLI |
| `make-assets.py` | Builds the icon, banner and invite splash in `assets/branding/discord/` from the official social art |

## Commands (from the repo root)

```bash
node tooling/community/discord/kc-discord.mjs check            # validate the declaration offline (also run by the tests)
node tooling/community/discord/kc-discord.mjs plan             # the declared server; with a token, a full live dry run
node tooling/community/discord/kc-discord.mjs apply            # make the live server match
node tooling/community/discord/kc-discord.mjs invite-url       # the link that adds the bot to the server
node tooling/community/discord/kc-discord.mjs changelog 0.1.9+1738          # preview a release post
node tooling/community/discord/kc-discord.mjs changelog 0.1.9+1738 --post   # post it to #changelog (no duplicates)
node tooling/community/discord/kc-discord.mjs roadmap          # preview #roadmap
```

**After every release,** run `changelog <id> --post`. If no bot is present, it posts through the `#changelog` webhook that `apply` saved locally.

**When the plan catalog changes** (a feature flips to available), run `apply` and `#roadmap` updates itself.

## One-time setup

Discord doesn't allow creating a bot or adding one to a server through its API, so these steps are manual:

1. **Create the bot.**
   - Open https://discord.com/developers/applications, choose **New Application** and name it **KalCode**.
   - On the **Bot** page, choose **Reset Token** and copy the token. No privileged intents are needed: the tool only uses REST.
2. **Store the token privately.** Paste it as one line into `%USERPROFILE%\.kalcode\discord\bot-token` (macOS: `~/.kalcode/discord/bot-token`).
   - Never put it in the repo, a chat or an environment file that gets committed.
   - `DISCORD_BOT_TOKEN` also works for one-off runs.
3. **Add the bot to the server.**
   - Run `kc-discord.mjs invite-url`, open the link and authorize it for KalCode.
   - It asks for **Administrator**, which setup needs: enabling Community, onboarding and AutoMod all require it.
4. **Apply.** Run `kc-discord.mjs plan`, then `kc-discord.mjs apply`.

**After setup, if you want least privilege,** take Administrator off the bot's role and leave it **Manage Webhooks**, **View Channels**, **Send Messages** and **Embed Links**. Changelog posting keeps working, and the webhook path doesn't need the bot at all. Re-grant Administrator only when running `apply` again.

**Optional extras:**

- **Boosts.** At boost level 1 the invite splash is set automatically, and at level 2 the banner. The art is ready in `assets/branding/discord/`.
- **Server Guide.** The resource list (Server Settings → Onboarding → Server Guide) has no public API. Onboarding questions, default channels and the welcome screen are all set by `apply`.

## What `apply` does, safely

- **Adopts before it creates.** Existing roles and channels are matched by name; the existing `#general` and General voice channel are reused, not duplicated.
- **Never deletes what it doesn't own.** Unmanaged channels are reported and left in place. The only deletions are:
  - Discord's empty default categories ("Text Channels", "Voice Channels");
  - the bot's own outdated `#roadmap` messages.
- **Idempotent.** A second run makes no changes. The tests prove this against an in-memory Discord (`fake-discord.mjs`).
- **Ordered correctly.** Roles and channels come first, then the rules and updates channels, then Community. After that come announcement channels, forums, AutoMod, onboarding and the welcome screen.
- **Secrets stay local.**
  - The token is read from the environment or `~/.kalcode/discord/bot-token` and never printed.
  - Webhook URLs (which embed a secret) are saved to `~/.kalcode/discord/webhooks.json`, owner-only.
  - Output passes through `redact()`, and every change carries an audit-log reason.
- **Rate-limit aware.** It retries 429s with `retry_after`, backs off on 5xx, and waits out exhausted buckets.

## Safety

AutoMod, which `apply` configures:

- spam;
- mention spam and raids (blocked, with a 10-minute timeout);
- hate and sexual content (Discord's presets);
- scams and malicious links (fake Discord gift domains, IP grabbers, crypto-doubling);
- **secrets**: API keys, provider tokens, GitHub/Slack/AWS/Google/Stripe keys, private keys and Discord tokens are blocked for everyone, with a note to revoke them;
- staff impersonation in names.

Alerts go to the private `#reports` channel.

Server settings:

- verification level Medium;
- the explicit media filter scans all members;
- default notifications are @mentions only;
- `@everyone` can't mention everyone.

The rules prohibit:

- harassment and hate;
- NSFW content;
- piracy and malware;
- credential sharing;
- scams and spam;
- impersonation.

The support and bug templates say plainly: never post passwords, API keys, provider tokens or private code.

## Truthfulness

- **`#roadmap` comes from the plan catalog.**
  - AVAILABLE means shipped and production-verified; COMING SOON means not shipped.
  - IN DEVELOPMENT appears only for feature ids listed in `server.mjs` `IN_DEVELOPMENT`, because the catalog has no such state.
  - There are no dates.
- **`#changelog` is built from the published release notes.** Anything in `PUBLICLY_UNAVAILABLE` (currently Gemini CLI, per kalcoded.com) is rewritten out of a list or the line is dropped, so a post never presents it as working.

## KalCode account linking (future-ready, not built)

Plan roles (Free, Pro, Max, Max 2X) are intentionally **not** created. When they are wanted, use Discord's **Linked Roles**, so entitlement is verified server-side and never typed by hand.

1. **Register metadata.** The KalCode API (`apps/api`) registers role-connection metadata once, with `PUT /applications/{app}/role-connections/metadata`. It is a single integer `plan_tier` (0 Free, 1 Pro, 2 Max, 3 Max 2X).
2. **Link.** In Discord, the member chooses **Linked Roles → KalCode**.
   - Discord OAuth (`role_connections.write identify`) redirects to the KalCode API.
   - The API verifies the member's KalCode session, reads the tier from the **signed server entitlement** (never from the client), and writes `PUT /users/@me/applications/{app}/role-connection` with `{ platform_name: "KalCode", metadata: { plan_tier } }`.
3. **Grant roles.** Discord grants roles whose requirements match, for example "Pro: `plan_tier ≥ 1`".
4. **Keep it current.** On a plan change, the entitlement webhook re-writes the role connection with the stored Discord refresh token (encrypted at rest), and the role follows automatically.
5. **Never exposed:** Stripe ids, emails, invoices or payment state. Discord only ever sees the tier number.
