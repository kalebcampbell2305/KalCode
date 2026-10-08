import type { LaunchRecipe } from "@kalcode/protocol";

export interface PartCounts {
  agents: number;
  terminals: number;
  browsers: number;
  services: number;
  other: number;
}

export function partCounts(recipe: Pick<LaunchRecipe, "components">): PartCounts {
  const counts: PartCounts = { agents: 0, terminals: 0, browsers: 0, services: 0, other: 0 };
  for (const part of recipe.components) {
    if (part.kind === "agent") counts.agents += 1;
    else if (part.kind === "terminal") counts.terminals += 1;
    else if (part.kind === "browser") counts.browsers += 1;
    else if (part.kind === "service") counts.services += 1;
    else counts.other += 1;
  }
  return counts;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** "2 agents · 1 terminal · 1 browser"; zero counts are left out. */
export function describeCounts(counts: PartCounts): string {
  const parts = [
    counts.agents ? plural(counts.agents, "agent") : "",
    counts.terminals ? plural(counts.terminals, "terminal") : "",
    counts.browsers ? plural(counts.browsers, "browser") : "",
    counts.services ? plural(counts.services, "service") : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Empty desk";
}

/** Moves `id` to index `to` of the list without it; returns a copy of `ids` when nothing moves. */
export function moveId(ids: readonly string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  const next = ids.filter((item) => item !== id);
  const target = Math.max(0, Math.min(next.length, to));
  if (from < 0 || target === from) return [...ids];
  next.splice(target, 0, id);
  return next;
}
