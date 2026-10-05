export type FavoriteKind =
  | "workspace"
  | "thread"
  | "agent"
  | "terminal"
  | "file"
  | "browser"
  | "account"
  | "command"
  | "run"
  | "service";

export interface FavoriteTarget {
  kind: FavoriteKind;
  id: string;
  workspaceId: string | null;
}

export interface FavoriteEntry {
  key: string;
  target: FavoriteTarget;
  title: string;
  /** null is a global pin; a workspace ID is a project favorite. */
  scopeId: string | null;
}

const KINDS = new Set<FavoriteKind>([
  "workspace",
  "thread",
  "agent",
  "terminal",
  "file",
  "browser",
  "account",
  "command",
  "run",
  "service",
]);
const validText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

export const INVALID_BROWSER_FAVORITE =
  "This web address can't be saved. Use an HTTP or HTTPS page without credentials or temporary sign-in tokens.";

/** Session IDs are global: a moved thread or its agent projection is the same target. */
export function favoriteTargetKey(target: FavoriteTarget): string {
  return JSON.stringify([
    target.kind === "agent" ? "thread" : target.kind,
    target.kind === "file" || target.kind === "browser" ? target.workspaceId : null,
    target.id,
  ]);
}

export function favoriteKey(target: FavoriteTarget, scopeId: string | null): string {
  return JSON.stringify([scopeId, favoriteTargetKey(target)]);
}

/** Persist only stable destination fields; never native handles, process state or credentials. */
export function normalizeFavoriteTarget(value: unknown): FavoriteTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (!KINDS.has(row.kind as FavoriteKind) || !validText(row.id, 4096)) return null;
  if (row.workspaceId !== null && !validText(row.workspaceId, 256)) return null;
  const target: FavoriteTarget = {
    kind: row.kind as FavoriteKind,
    id: row.id,
    workspaceId: row.workspaceId as string | null,
  };
  if (target.kind === "file") {
    target.id = target.id.replaceAll("\\", "/");
    if (
      !target.workspaceId ||
      target.id.startsWith("/") ||
      /^[a-z]:/i.test(target.id) ||
      target.id.split("/").some((part) => !part || part === "." || part === "..")
    )
      return null;
  }
  if (target.kind === "terminal" && !target.workspaceId) return null;
  if (target.kind === "browser") {
    try {
      const url = new URL(target.id);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      // Authentication links and signed/session URLs must not become a second secret store.
      const sensitive =
        /(?:^|[_-])(?:token|secret|password|credential|signature|session|auth|code|key)(?:$|[_-])|^(?:accessToken|refreshToken|idToken|apiKey|clientSecret|sessionId|authToken|sig)$/i;
      if (
        [...url.searchParams.keys()].some((key) => sensitive.test(key)) ||
        /(?:token|secret|password|credential|signature|session|auth|code|key)=/i.test(url.hash)
      )
        return null;
      target.id = url.href;
    } catch {
      return null;
    }
  }
  return target;
}

export function normalizeFavorite(value: unknown): FavoriteEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const target = normalizeFavoriteTarget(row.target);
  if (!target || !validText(row.title, 256) || (row.scopeId !== null && !validText(row.scopeId, 256))) return null;
  const scopeId = row.scopeId as string | null;
  return { key: favoriteKey(target, scopeId), target, title: row.title.trim(), scopeId };
}

export function hydrateFavorites(raw: string | null): FavoriteEntry[] {
  if (raw === null) return [];
  if (raw.length > 1_048_576) throw new Error("Saved favorites are too large to read.");
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("entries" in parsed) ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length > 1000
  ) {
    throw new Error("This saved favorites format cannot be read.");
  }
  const seen = new Set<string>();
  return parsed.entries.flatMap((value) => {
    const entry = normalizeFavorite(value);
    if (!entry || seen.has(entry.key)) return [];
    seen.add(entry.key);
    return [entry];
  });
}
