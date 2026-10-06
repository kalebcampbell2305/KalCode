// #roadmap, rendered from the canonical plan catalog (packages/protocol/src/plans.ts), the same source
// as the kalcoded.com roadmap. "available" means shipped and production-verified; "coming_soon" means
// not shipped. IN DEVELOPMENT lists only ids the owner names in server.mjs (the catalog has no such
// state, so nothing is guessed). No dates, ever, unless the catalog carries them.
import { pathToFileURL } from "node:url";
import { SIGNOFF } from "./content.mjs";
import { EMBED_COLOR, IN_DEVELOPMENT, LINKS } from "./server.mjs";

const EMBED_LIMIT = 4000; // per-description budget, under Discord's 4096
const MESSAGE_LIMIT = 5800; // per-message embed total, under Discord's 6000

export async function loadCatalog(plansPath) {
  const mod = await import(pathToFileURL(plansPath).href);
  return mod.PLAN_FEATURE_GROUPS;
}

/** Sections in display order: { key, title, groups: [{ title, items: [label] }] }. */
export function roadmapSections(groups, inDevelopment = IN_DEVELOPMENT) {
  const dev = new Set(inDevelopment);
  const known = new Set(groups.flatMap((g) => g.features.map((f) => f.id)));
  for (const id of dev) if (!known.has(id)) throw new Error(`IN_DEVELOPMENT names unknown feature id "${id}"`);
  const pick = (pred) =>
    groups
      .map((g) => ({ title: g.title, items: g.features.filter(pred).map((f) => f.label) }))
      .filter((g) => g.items.length);
  return [
    { key: "available", title: "AVAILABLE", groups: pick((f) => f.status === "available") },
    { key: "in_development", title: "IN DEVELOPMENT", groups: pick((f) => f.status !== "available" && dev.has(f.id)) },
    { key: "coming_soon", title: "COMING SOON", groups: pick((f) => f.status !== "available" && !dev.has(f.id)) },
  ].filter((s) => s.groups.length);
}

/** Message payloads (each ≤ Discord limits). Each section starts its own message. */
export function roadmapMessages(groups, inDevelopment = IN_DEVELOPMENT) {
  const sections = roadmapSections(groups, inDevelopment);
  const messages = [];
  const intro = {
    color: EMBED_COLOR,
    title: "KalCode roadmap",
    url: `${LINKS.site}/#roadmap`,
    description: [
      "Everything under **AVAILABLE** is in the KalCode you can download today. **COMING SOON** is planned but not shipped yet: no dates until they're real.",
      "",
      "This list is generated from the same catalog as kalcoded.com, so the two always match. Ideas go in {#features}.",
    ].join("\n"),
    footer: { text: SIGNOFF },
  };
  messages.push({ key: "roadmap-intro", embeds: [intro] });
  for (const s of sections) {
    const embeds = [];
    let body = "";
    const flush = () => {
      if (!body) return;
      const title = embeds.length ? `${s.title} (continued)` : s.title;
      embeds.push({ color: s.key === "available" ? 0x3ccf8e : EMBED_COLOR, title, description: body.trim() });
      body = "";
    };
    for (const g of s.groups) {
      const block = `**${g.title}**\n${g.items.map((i) => `• ${i}`).join("\n")}\n\n`;
      if (body.length + block.length > EMBED_LIMIT) flush();
      body += block;
    }
    flush();
    // Split the section's embeds across messages so no message passes the 6000-character total.
    let batch = [];
    let size = 0;
    embeds.forEach((e, i) => {
      const n = e.title.length + e.description.length;
      if (batch.length && (size + n > MESSAGE_LIMIT || batch.length === 10)) {
        messages.push({ key: `roadmap-${s.key}-${messages.length}`, embeds: batch });
        batch = [];
        size = 0;
      }
      batch.push(e);
      size += n;
      if (i === embeds.length - 1) messages.push({ key: `roadmap-${s.key}`, embeds: batch });
    });
  }
  return messages;
}
