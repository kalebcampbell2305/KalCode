import type { LocatorEntityKind, LocatorResult } from "@kalcode/protocol";

/**
 * The small, privacy-safe description KalVoice needs to resolve references to UI/runtime
 * objects. It deliberately carries labels and stable ids, never terminal output, prompts,
 * provider responses, credentials, or filesystem contents.
 */
export type VoiceSceneKind =
  | LocatorEntityKind
  | "browser"
  | "run"
  | "queue_item"
  | "service"
  | "environment"
  | "dashboard"
  | "widget"
  | "git";

export interface VoiceSceneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VoiceSceneTarget {
  kind: VoiceSceneKind;
  entityId: string;
  title: string;
  aliases?: readonly string[];
  subtitle?: string | null;
  status?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  providerId?: string | null;
  providerName?: string | null;
  providerAccountId?: string | null;
  accountLabel?: string | null;
  model?: string | null;
  effort?: string | null;
  branch?: string | null;
  paneId?: string | null;
  updatedAt?: string | null;
  visible?: boolean;
  focused?: boolean;
  rect?: VoiceSceneRect | null;
  /** A coding agent: a provider CLI in a Code terminal pane (not a chat thread). */
  codingAgent?: boolean;
}

export type VoiceSceneReference =
  | { kind: "named"; query: string; kinds?: readonly VoiceSceneKind[] }
  | { kind: "current" }
  | { kind: "last_target" }
  | { kind: "other"; query: string; kinds?: readonly VoiceSceneKind[] }
  | { kind: "beside_current" }
  /** `agents`: the person said "agent", so only coding agents count (AGENTS.md). */
  | { kind: "latest_completed"; agents?: boolean }
  | { kind: "latest_failed"; agents?: boolean };

export interface VoiceSceneContext {
  targets: readonly VoiceSceneTarget[];
  /** The target established by the preceding voice turn. */
  lastTarget?: VoiceSceneTarget | null;
  kinds?: readonly VoiceSceneKind[];
  workspaceId?: string | null;
}

export type VoiceSceneResolution =
  | { kind: "resolved"; target: VoiceSceneTarget }
  | { kind: "ambiguous"; choices: VoiceSceneTarget[] }
  | { kind: "not_found" };

const QUERY_FILLER = new Set([
  "a",
  "an",
  "the",
  "my",
  "me",
  "please",
  "open",
  "find",
  "show",
  "focus",
  "go",
  "to",
  "working",
  "on",
  "for",
  "called",
  "named",
  "terminal",
  "thread",
  "session",
  "agent",
  "pane",
]);

const COMPLETED = new Set(["completed", "done", "succeeded", "success", "finished", "exited"]);
const FAILED = new Set(["failed", "error", "interrupted"]);

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function queryWords(value: string): string[] {
  const words = normalize(value).split(" ").filter(Boolean);
  const meaningful = words.filter((word) => !QUERY_FILLER.has(word));
  return meaningful.length > 0 ? meaningful : words;
}

function targetNames(target: VoiceSceneTarget): string[] {
  return [target.title, ...(target.aliases ?? []), target.subtitle ?? "", target.providerId ?? ""]
    .map(normalize)
    .filter(Boolean);
}

function hasWordPrefix(value: string, prefix: string): boolean {
  return value.split(" ").some((word) => word.startsWith(prefix));
}

function hasWholePhrase(value: string, phrase: string): boolean {
  return (
    value === phrase || value.startsWith(`${phrase} `) || value.endsWith(` ${phrase}`) || value.includes(` ${phrase} `)
  );
}

function sameTarget(a: VoiceSceneTarget, b: VoiceSceneTarget): boolean {
  return a.kind === b.kind && a.entityId === b.entityId;
}

function filtered(context: VoiceSceneContext): VoiceSceneTarget[] {
  const kinds = context.kinds ? new Set(context.kinds) : null;
  return context.targets.filter(
    (target) =>
      (!kinds || kinds.has(target.kind)) &&
      (!context.workspaceId || !target.workspaceId || target.workspaceId === context.workspaceId),
  );
}

function namedScore(query: string, target: VoiceSceneTarget): number {
  const needle = normalize(query);
  if (!needle) return 0;
  const names = targetNames(target);
  if (names.some((name) => name === needle)) return 4;
  if (names.some((name) => name.startsWith(needle))) return 3;
  if (names.some((name) => hasWordPrefix(name, needle))) return 2;
  const words = queryWords(query);
  return words.length > 0 && words.every((word) => names.some((name) => hasWordPrefix(name, word))) ? 1 : 0;
}

function readableProvider(providerId: string | null | undefined): string | null {
  if (!providerId) return null;
  if (providerId === "claude-code") return "Claude Code";
  if (providerId === "gemini-cli") return "Gemini CLI";
  return providerId
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/** A concise, privacy-bounded chooser row that keeps duplicate object names distinguishable. */
export function sceneChoiceLabel(target: VoiceSceneTarget): string {
  const title = target.title.trim();
  const titleKey = normalize(title);
  const seen = new Set<string>();
  const metadata = [
    target.workspaceName,
    target.providerName ?? readableProvider(target.providerId),
    target.accountLabel,
    target.subtitle,
  ].flatMap((value) => {
    const text = value?.trim();
    if (!text) return [];
    const key = normalize(text);
    if (!key || seen.has(key) || hasWholePhrase(titleKey, key)) return [];
    seen.add(key);
    return [text];
  });
  return metadata.length > 0 ? `${title} — ${metadata.join(" · ")}` : title;
}

function resolveNamed(query: string, targets: readonly VoiceSceneTarget[]): VoiceSceneResolution {
  const scored = targets
    .map((target) => ({ target, score: namedScore(query, target) }))
    .filter(({ score }) => score > 0);
  const best = Math.max(0, ...scored.map(({ score }) => score));
  const choices = scored.filter(({ score }) => score === best).map(({ target }) => target);
  if (choices.length === 1) return { kind: "resolved", target: choices[0] as VoiceSceneTarget };
  return choices.length > 1 ? { kind: "ambiguous", choices } : { kind: "not_found" };
}

function timestamp(target: VoiceSceneTarget): number {
  const parsed = Date.parse(target.updatedAt ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function latestWithStatus(targets: readonly VoiceSceneTarget[], statuses: ReadonlySet<string>): VoiceSceneResolution {
  const choices = targets
    .filter((target) => statuses.has(normalize(target.status ?? "")))
    .sort((a, b) => timestamp(b) - timestamp(a));
  if (choices.length === 0) return { kind: "not_found" };
  const newest = timestamp(choices[0] as VoiceSceneTarget);
  const tied = choices.filter((target) => timestamp(target) === newest);
  return tied.length === 1
    ? { kind: "resolved", target: tied[0] as VoiceSceneTarget }
    : { kind: "ambiguous", choices: tied };
}

function horizontalDistance(a: VoiceSceneRect, b: VoiceSceneRect): number | null {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (overlap <= 0) return null;
  const gap = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const centerDelta = Math.abs(a.y + a.height / 2 - (b.y + b.height / 2));
  return gap * 1_000 + centerDelta;
}

function besideCurrent(targets: readonly VoiceSceneTarget[]): VoiceSceneResolution {
  const current = targets.find((target) => target.focused && target.visible !== false && target.rect);
  if (!current?.rect) return { kind: "not_found" };
  const scored = targets
    .filter((target) => !sameTarget(target, current) && target.visible !== false && target.rect)
    .map((target) => ({
      target,
      distance: horizontalDistance(current.rect as VoiceSceneRect, target.rect as VoiceSceneRect),
    }))
    .filter((item): item is { target: VoiceSceneTarget; distance: number } => item.distance !== null)
    .sort((a, b) => a.distance - b.distance);
  if (scored.length === 0) return { kind: "not_found" };
  const best = scored[0]?.distance;
  const tied = scored.filter(({ distance }) => distance === best).map(({ target }) => target);
  return tied.length === 1
    ? { kind: "resolved", target: tied[0] as VoiceSceneTarget }
    : { kind: "ambiguous", choices: tied };
}

/**
 * Resolves an already-classified reference against one current scene snapshot. It never guesses:
 * equal best matches are returned for the UI's concise "Which one?" chooser.
 */
export function resolveVoiceSceneTarget(
  reference: VoiceSceneReference,
  context: VoiceSceneContext,
): VoiceSceneResolution {
  const referenceKinds = "kinds" in reference ? reference.kinds : undefined;
  const kinds =
    referenceKinds && context.kinds
      ? referenceKinds.filter((kind) => context.kinds?.includes(kind))
      : (referenceKinds ?? context.kinds);
  const targets = filtered({ ...context, kinds });
  switch (reference.kind) {
    case "current": {
      const choices = targets.filter((target) => target.focused);
      if (choices.length === 1) return { kind: "resolved", target: choices[0] as VoiceSceneTarget };
      return choices.length > 1 ? { kind: "ambiguous", choices } : { kind: "not_found" };
    }
    case "last_target": {
      const live = context.lastTarget
        ? targets.find((target) => sameTarget(target, context.lastTarget as VoiceSceneTarget))
        : null;
      return live ? { kind: "resolved", target: live } : { kind: "not_found" };
    }
    case "other": {
      const current = targets.find((target) => target.focused);
      return resolveNamed(
        reference.query,
        current ? targets.filter((target) => !sameTarget(target, current)) : targets,
      );
    }
    case "beside_current":
      return besideCurrent(targets);
    case "latest_completed":
      return latestWithStatus(reference.agents ? targets.filter((t) => t.codingAgent) : targets, COMPLETED);
    case "latest_failed":
      return latestWithStatus(reference.agents ? targets.filter((t) => t.codingAgent) : targets, FAILED);
    case "named":
      return resolveNamed(reference.query, targets);
  }
}

/** Adapts the existing local Session Locator result without adding another index or store. */
export function sceneTargetFromLocator(result: LocatorResult): VoiceSceneTarget {
  return {
    kind: result.kind,
    entityId: result.entityId,
    title: result.title,
    subtitle: result.subtitle,
    status: result.status,
    workspaceId: result.workspaceId,
    providerId: result.providerId,
    updatedAt: result.updatedAt,
  };
}
