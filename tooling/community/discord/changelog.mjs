// Release notes (docs/releases/<version>+<build>.md) → a #changelog post. The notes are the source of
// truth; this only reshapes them: bullets become one-liners under NEW and FIXED, with a link to the
// full notes on kalcoded.com.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SIGNOFF } from "./content.mjs";
import { EMBED_COLOR, LINKS, PUBLICLY_UNAVAILABLE } from "./server.mjs";

const FIX =
  /\b(no longer|fix(es|ed)?|reliab|crash|correct(ly|s|ed)?|instead of failing|recover|truthful|stays where)\b/i;
const MAX_ITEM = 140;
const MAX_ITEMS = 8;

/** `0.1.9+1738` → { version: "0.1.9", build: 1738 }; `0.1.9` → { version, build: null }. */
export function parseReleaseId(id) {
  const m = /^(\d+\.\d+\.\d+)(?:\+(\d+))?$/.exec(id);
  if (!m) throw new Error(`not a release id: ${id}`);
  return { version: m[1], build: m[2] ? Number(m[2]) : null };
}

/** Release ids found in docs/releases, oldest first (version, then build). */
export function listReleases(dir) {
  return readdirSync(dir)
    .map((f) => /^(\d+\.\d+\.\d+(?:\+\d+)?)\.md$/.exec(f)?.[1])
    .filter(Boolean)
    .sort(compareReleases);
}

export function compareReleases(a, b) {
  const pa = parseReleaseId(a);
  const pb = parseReleaseId(b);
  const va = pa.version.split(".").map(Number);
  const vb = pb.version.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] - vb[i];
  return (pa.build ?? 0) - (pb.build ?? 0);
}

/** The bullets of the first "New in…"/"New since…" section, or of the whole file if it has none. */
export function extractBullets(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let start = lines.findIndex((l) => /^##+\s+New (in|since)\b/i.test(l));
  let end = lines.length;
  if (start >= 0) {
    const next = lines.findIndex((l, i) => i > start && /^##?\s/.test(l));
    end = next < 0 ? lines.length : next;
  } else start = 0;
  const bullets = [];
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (/^\s*[-*]\s+/.test(line) && !/^\s{2,}/.test(line)) bullets.push(line.replace(/^\s*[-*]\s+/, ""));
    else if (bullets.length && /^\s{2,}\S/.test(line)) bullets[bullets.length - 1] += ` ${line.trim()}`;
    else if (/^##+\s+(Platforms|Downloads|Upgrading)/i.test(line)) break;
  }
  return bullets.filter((b) => !/^\s*\|/.test(b));
}

/** One bullet → a short line: its bold lead if it has one, else its first sentence, trimmed. */
export function summarize(bullet) {
  const lead = /^\*\*(.+?)\*\*/.exec(bullet);
  let text = lead ? lead[1] : (bullet.split(/(?<=[.!?])\s/)[0] ?? bullet);
  text = text
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:]$/, "");
  if (text.length > MAX_ITEM) text = `${text.slice(0, MAX_ITEM - 1).replace(/\s+\S*$/, "")}…`;
  return text;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Removes a publicly unavailable name from a list ("A, B and X" → "A and B"). Returns null when the
 * line can't be cleanly rewritten, so the caller drops it instead of advertising the unavailable thing.
 */
export function withoutUnavailable(text, unavailable = PUBLICLY_UNAVAILABLE) {
  let out = text;
  for (const name of unavailable) {
    const n = escapeRe(name);
    out = out.replace(new RegExp(`, ([^,]+?) and ${n}\\b`, "g"), " and $1");
    if (new RegExp(`\\b${n}\\b`).test(out)) return null;
  }
  return out;
}

export function classify(bullet) {
  return FIX.test(bullet) ? "fixed" : "new";
}

/** The Discord message payload for one release. */
export function changelogPost(id, markdown) {
  const { version, build } = parseReleaseId(id);
  const bullets = extractBullets(markdown);
  const groups = { new: [], fixed: [] };
  for (const b of bullets) {
    // The posted line is the one-line summary; it must never present an unavailable provider as working.
    const line = withoutUnavailable(summarize(b));
    if (line) groups[classify(b)].push(line);
  }
  const section = (title, items) => {
    if (!items.length) return [];
    const shown = items.slice(0, MAX_ITEMS).map((t) => `• ${t}`);
    if (items.length > MAX_ITEMS) shown.push(`• …and ${items.length - MAX_ITEMS} more in the full notes`);
    return [`**${title}**`, ...shown, ""];
  };
  const description = [
    ...section("NEW", groups.new),
    ...section("FIXED", groups.fixed),
    `[Full notes](${LINKS.updates}) · [Download](${LINKS.download})`,
  ].join("\n");
  return {
    embeds: [
      {
        color: EMBED_COLOR,
        title: changelogTitle(id),
        url: LINKS.updates,
        description: description.slice(0, 4000),
        footer: { text: SIGNOFF },
      },
    ],
    allowed_mentions: { parse: [] },
    _meta: { version, build, items: bullets.length },
  };
}

export function changelogTitle(id) {
  const { version, build } = parseReleaseId(id);
  return build ? `KalCode ${version} · build ${build}` : `KalCode ${version}`;
}

export function readRelease(repoRoot, id) {
  return readFileSync(join(repoRoot, "docs", "releases", `${id}.md`), "utf8");
}
