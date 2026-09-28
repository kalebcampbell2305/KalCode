/**
 * The session resolver for the in-memory transport (unit tests and the `ui-test` Playwright
 * build ONLY; never bundled into development or production builds). A line-for-line mirror of
 * native `apps/desktop/src-tauri/src/session_resolver.rs`; both must pass every case in
 * `session_resolver_cases.json` next to it.
 */
import type { SessionCandidate, SessionMatchTier, SessionResolution, ThreadSummary } from "@kalcode/protocol";

/** Mirrors `MAX_SESSION_CHOICES` / `MAX_SESSION_QUERY_CHARS` (crates/contracts/src/sessions.rs). */
export const MAX_SESSION_CHOICES = 4;
export const MAX_SESSION_QUERY_CHARS = 200;

export interface ResolveContext {
  workspaceId?: string | null;
  focusedThreadId?: string | null;
  lastTargetId?: string | null;
}

const PRONOUNS = new Set([
  "this",
  "that",
  "it",
  "here",
  "this one",
  "that one",
  "this thread",
  "that thread",
  "this session",
  "that session",
  "current thread",
  "the current thread",
  "current session",
  "the current session",
]);
const LEADING_FILLER = new Set(["the", "my", "our"]);
const TRAILING_FILLER = new Set([
  "thread",
  "session",
  "terminal",
  "agent",
  "chat",
  "conversation",
  "pane",
  "tab",
  "one",
]);
const QUALIFIER_FILLER = new Set([
  "the",
  "my",
  "our",
  "on",
  "in",
  "using",
  "with",
  "from",
  "for",
  "of",
  "s",
  "account",
  "thread",
  "threads",
  "session",
  "agent",
  "one",
  "pane",
  "terminal",
]);

/** U+00C0–U+017F folded to ASCII (identical to native `FOLD`); `.` = see `foldWide`. */
const FOLD =
  "aaaaaa.ceeeeiiii.nooooo.ouuuuy..aaaaaa.ceeeeiiii.nooooo.ouuuuy.yaaaaaaccccccccddddeeeeeeeeeegggggggghhhhiiiiiiiiii..jjkk.llllllllllnnnnnnn..oooooo..rrrrrrsssssssstttt..uuuuuuuuuuuuwwyyyzzzzzzs";

function foldWide(cp: number): string {
  switch (cp) {
    case 0xc6:
    case 0xe6:
      return "ae";
    case 0xd0:
    case 0xf0:
      return "d";
    case 0xde:
    case 0xfe:
      return "th";
    case 0xdf:
      return "ss";
    case 0x132:
    case 0x133:
      return "ij";
    case 0x138:
      return "k";
    case 0x14a:
    case 0x14b:
      return "n";
    case 0x152:
    case 0x153:
      return "oe";
    case 0x166:
    case 0x167:
      return "t";
    default:
      return " ";
  }
}

const ALPHANUMERIC = /^[\p{Alphabetic}\p{N}]$/u;

/** Lower-cased, Latin diacritics folded, combining marks dropped, other punctuation a space. */
export function normalizeSessionText(text: string): string {
  let out = "";
  for (const c of text) {
    const cp = c.codePointAt(0) ?? 0;
    if (cp >= 0xc0 && cp < 0x180) {
      const folded = FOLD[cp - 0xc0];
      out += folded === "." ? foldWide(cp) : folded;
    } else if (cp >= 0x300 && cp < 0x370) {
      // Combining diacritical marks (a decomposed "é").
    } else if (ALPHANUMERIC.test(c)) {
      out += c.toLowerCase();
    } else {
      out += " ";
    }
  }
  return out.split(" ").filter(Boolean).join(" ");
}

const words = (normalized: string) => normalized.split(" ").filter(Boolean);

function clean(normalized: string): string {
  const tokens = words(normalized);
  while (tokens.length > 1 && LEADING_FILLER.has(tokens[0] ?? "")) tokens.shift();
  while (tokens.length > 1 && TRAILING_FILLER.has(tokens[tokens.length - 1] ?? "")) tokens.pop();
  return tokens.join(" ");
}

export function typoBudget(length: number): number {
  if (length <= 4) return 0;
  if (length <= 9) return 1;
  return 2;
}

/** Optimal-string-alignment distance ≤ `max` (insert, delete, substitute, swap neighbours). */
export function withinDistance(left: string, right: string, max: number): boolean {
  const a = [...left];
  const b = [...right];
  if (Math.abs(a.length - b.length) > max) return false;
  const rows = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let j = 0; j <= b.length; j++) (rows[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const row = rows[i] as number[];
    const up = rows[i - 1] as number[];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min((up[j] as number) + 1, (row[j - 1] as number) + 1, (up[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, ((rows[i - 2] as number[])[j - 2] as number) + 1);
      }
      row[j] = d;
    }
  }
  return ((rows[a.length] as number[])[b.length] as number) <= max;
}

interface Entry {
  t: ThreadSummary;
  name: string;
  nameTokens: string[];
  qualifiers: Set<string>;
}

function entry(t: ThreadSummary): Entry {
  const name = normalizeSessionText(t.name);
  const qualifiers = new Set([
    ...words(normalizeSessionText(t.providerName)),
    ...words(normalizeSessionText(t.providerId)),
    ...(t.accountLabel ? words(normalizeSessionText(t.accountLabel)) : []),
  ]);
  return { t, name, nameTokens: words(name), qualifiers };
}

function matchesQualifiedName(e: Entry, tokens: string[]): boolean {
  const n = e.nameTokens.length;
  if (n === 0 || tokens.length <= n) return false;
  const nameIs = (part: string[]) => part.every((word, i) => word === e.nameTokens[i]);
  let rest: string[];
  if (nameIs(tokens.slice(tokens.length - n))) rest = tokens.slice(0, tokens.length - n);
  else if (nameIs(tokens.slice(0, n))) rest = tokens.slice(n);
  else return false;
  const real = rest.filter((w) => !QUALIFIER_FILLER.has(w));
  return real.length > 0 && real.every((w) => e.qualifiers.has(w));
}

/** "Name · Provider · Account" (the account part only when the thread has one). */
export function sessionLabel(t: ThreadSummary): string {
  const account = t.accountLabel?.trim();
  return account ? `${t.name} · ${t.providerName} · ${account}` : `${t.name} · ${t.providerName}`;
}

export function sessionCandidate(t: ThreadSummary): SessionCandidate {
  return {
    threadId: t.id,
    name: t.name,
    providerId: t.providerId,
    providerName: t.providerName,
    accountLabel: t.accountLabel,
    workspaceId: t.workspaceId,
    workspaceName: t.workspaceName,
    status: t.status,
    label: sessionLabel(t),
  };
}

const notFound = (message: string): SessionResolution => ({ kind: "not_found", message });
const missing = () => notFound("KalCode couldn't find an open session with that name.");
const resolved = (e: Entry, tier: SessionMatchTier): SessionResolution => ({
  kind: "resolved",
  target: sessionCandidate(e.t),
  tier,
});

function joinOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

function allDistinct(keys: string[]): boolean {
  return new Set(keys).size === keys.length;
}

function describe(choices: ThreadSummary[]): string[] | null {
  const names = choices.map((t) => t.name);
  const folded = names.map(normalizeSessionText);
  if (allDistinct(folded)) return names;
  const fields: ((t: ThreadSummary) => [string, string] | null)[] = [
    (t) => {
      const account = t.accountLabel?.trim();
      return account ? ["on", account] : null;
    },
    (t) => ["on", t.providerName],
    (t) => ["in", t.workspaceName],
  ];
  for (const field of fields) {
    const values = choices.map(field);
    if (values.some((v) => v === null)) continue;
    const present = values as [string, string][];
    const keys = folded.map((name, i) => `${name}\u0000${normalizeSessionText((present[i] as [string, string])[1])}`);
    if (allDistinct(keys)) {
      return names.map((name, i) => {
        const [word, value] = present[i] as [string, string];
        return `${name} ${word} ${value}`;
      });
    }
  }
  return null;
}

function ambiguous(matches: Entry[], ctx: ResolveContext): SessionResolution {
  const inWorkspace = (e: Entry) => (ctx.workspaceId ? e.t.workspaceId === ctx.workspaceId : false);
  // Current workspace first; otherwise the listing's order (Array.prototype.sort is stable).
  const ordered = [...matches].sort((a, b) => Number(!inWorkspace(a)) - Number(!inWorkspace(b)));
  const total = ordered.length;
  const shown = ordered.slice(0, MAX_SESSION_CHOICES).map((e) => e.t);
  const names = describe(shown);
  let question = names ? `Which one — ${joinOr(names)}?` : `Which one? ${total} sessions match that name.`;
  if (total > shown.length && !question.includes("sessions match")) {
    question += ` ${total} sessions match; say more of the name.`;
  }
  return { kind: "ambiguous", question, choices: shown.map(sessionCandidate), total };
}

function decide(matches: Entry[], tier: SessionMatchTier, ctx: ResolveContext): SessionResolution {
  if (matches.length === 0) return missing();
  if (matches.length === 1) return resolved(matches[0] as Entry, tier);
  return ambiguous(matches, ctx);
}

/** Resolves `query` against `threads` (the store listing, most recent first). */
export function resolveSession(
  threads: readonly ThreadSummary[],
  query: string,
  ctx: ResolveContext = {},
): SessionResolution {
  const trimmed = query.trim();
  if (!trimmed) return notFound("Say which session, for example “Authentication”.");
  if ([...trimmed].length > MAX_SESSION_QUERY_CHARS) return missing();
  const open = threads.filter((t) => !t.archivedAt).map(entry);
  const inWorkspace = (e: Entry) => (ctx.workspaceId ? e.t.workspaceId === ctx.workspaceId : false);
  const preferWorkspace = (matches: Entry[]) => {
    const here = matches.filter(inWorkspace);
    return here.length > 0 ? here : matches;
  };

  // 1. Explicit id.
  const byId = open.find((e) => e.t.id.toLowerCase() === trimmed.toLowerCase());
  if (byId) return resolved(byId, "explicit_id");

  const raw = normalizeSessionText(trimmed);
  const cleaned = clean(raw);

  // 2 + 3. Exact name, the current workspace first.
  const exact = open.filter((e) => e.name === raw || e.name === cleaned);
  if (exact.length > 0) {
    const here = exact.filter(inWorkspace);
    if (here.length > 0) return decide(here, "exact_name_in_workspace", ctx);
    return decide(exact, "exact_name", ctx);
  }

  const tokens = words(cleaned);

  // 4. Provider and/or account words plus the name.
  const qualified = open.filter((e) => matchesQualifiedName(e, tokens));
  if (qualified.length > 0) return decide(preferWorkspace(qualified), "provider_account_name", ctx);

  // 5. "this / that / it".
  if (PRONOUNS.has(raw)) {
    const find = (id: string | null | undefined) => (id ? open.find((e) => e.t.id === id) : undefined);
    const focused = find(ctx.focusedThreadId);
    if (focused) return resolved(focused, "focused");
    const last = find(ctx.lastTargetId);
    if (last) return resolved(last, "last_target");
    return notFound("No session is open here. Say its name.");
  }

  // 6. Only provider and/or account words.
  const real = tokens.filter((w) => !QUALIFIER_FILLER.has(w));
  if (real.length > 0) {
    const byProvider = open.filter((e) => real.every((w) => e.qualifiers.has(w)));
    if (byProvider.length > 0) return decide(preferWorkspace(byProvider), "provider_only", ctx);
  }

  // 7. Bounded fuzzy: a word-start fragment, then a typo or two; never workspace-preferred.
  if (cleaned) {
    const fragment = open.filter((e) => ` ${e.name}`.includes(` ${cleaned}`));
    if (fragment.length > 0) return decide(fragment, "fuzzy", ctx);
    const budget = typoBudget([...cleaned].length);
    if (budget > 0) {
      const typos = open.filter((e) => withinDistance(cleaned, e.name, budget));
      if (typos.length > 0) return decide(typos, "fuzzy", ctx);
    }
  }
  return missing();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `session_resolve` command handler, validated like native: optional context ids must be
 * canonical ids. `listOpenThreads` is the transport's own `thread_list` (Dashboard fixtures
 * included), so every surface resolves against the same registry.
 */
export function sessionResolveHandler(listOpenThreads: () => unknown) {
  return async (args: Record<string, unknown>): Promise<SessionResolution> => {
    const query = typeof args.query === "string" ? args.query : null;
    const context = [args.workspaceId, args.focusedThreadId, args.lastTargetId];
    if (query === null || context.some((v) => v !== null && v !== undefined && typeof v !== "string")) {
      throw {
        category: "internal",
        code: "ipc_rejected",
        message: "KalCode couldn't complete that request.",
        retryable: false,
      };
    }
    if (context.some((v) => typeof v === "string" && !UUID.test(v))) {
      throw {
        category: "validation",
        code: "invalid_session_context",
        message: "That workspace or thread id is invalid.",
        retryable: false,
      };
    }
    const threads = (await listOpenThreads()) as ThreadSummary[];
    return resolveSession(threads, query, {
      workspaceId: (args.workspaceId as string | null | undefined) ?? null,
      focusedThreadId: (args.focusedThreadId as string | null | undefined) ?? null,
      lastTargetId: (args.lastTargetId as string | null | undefined) ?? null,
    });
  };
}
