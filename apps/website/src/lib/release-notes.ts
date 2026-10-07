/**
 * Builds of a public version, read from the release notes the release tooling publishes
 * (docs/releases/<version>+<build>.md). The /updates timeline lists these, so a newly shipped
 * build appears without anyone editing the page.
 */
export interface BuildNotes {
  build: number;
  /** One line: the lead phrases of the first highlights. */
  title: string;
  /** The highlights, one sentence each ("Lead. First sentence."). */
  points: string[];
}

const MAX_POINTS = 6;

/** Strips Markdown emphasis and code marks from a line of release notes. */
function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first sentence of a bullet's body (after its bold lead). */
function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : text).trim();
}

/** Parses one release-notes file; null when it has no "New in this build" bullets. */
export function parseBuildNotes(build: number, markdown: string): BuildNotes | null {
  const section = markdown.split(/^## New in this build\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const bullets = section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
  if (bullets.length === 0) return null;

  const leads: string[] = [];
  const points = bullets.map((bullet) => {
    const lead = bullet.match(/^\*\*(.+?)\*\*\s*(.*)$/);
    if (!lead) return firstSentence(plain(bullet));
    const leadText = plain(lead[1] ?? "").replace(/[.:]$/, "");
    leads.push(leadText);
    const rest = firstSentence(plain(lead[2] ?? ""));
    return rest ? `${leadText}. ${rest}` : `${leadText}.`;
  });

  const heads = leads.slice(0, 3);
  const title = heads.length > 0 ? `${heads.join(", ")}.` : (points[0] ?? "");
  return { build, title, points: points.slice(0, MAX_POINTS) };
}

/** Every build of `version` with notes, newest first, from a {path: markdown} map. */
export function buildsFromNotes(version: string, files: Record<string, string>): BuildNotes[] {
  const pattern = new RegExp(`${version.replace(/\./g, "\\.")}\\+(\\d+)\\.md$`);
  return Object.entries(files)
    .map(([path, markdown]) => {
      const build = Number(path.match(pattern)?.[1]);
      return Number.isFinite(build) && build > 0 ? parseBuildNotes(build, markdown) : null;
    })
    .filter((entry): entry is BuildNotes => entry !== null)
    .sort((a, b) => b.build - a.build);
}

/** The repository's published 0.1.9 release notes, read at build time. */
export const NOTES_019 = buildsFromNotes(
  "0.1.9",
  import.meta.glob("../../../../docs/releases/0.1.9+*.md", { query: "?raw", import: "default", eager: true }),
);

/** The repository's published 0.1.10 release notes, read at build time. */
export const NOTES_0110 = buildsFromNotes(
  "0.1.10",
  import.meta.glob("../../../../docs/releases/0.1.10+*.md", { query: "?raw", import: "default", eager: true }),
);
