import type { ProviderAccount } from "@kalcode/protocol";

/**
 * Command-palette account switching (0.1.5): "switch gemini b", "switch to gemini a",
 * "use codex work", "use claude personal". Pure matching only; the palette decides what the
 * items do (a thread rebind always goes through the Rebind dialog, never silently).
 */

export const ACCOUNT_PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

/** Spoken or typed provider names, longest first, as the provider is written before a label. */
const PROVIDER_ALIASES: Record<string, string[][]> = {
  "claude-code": [["claude", "code"], ["claude"]],
  codex: [["codex"]],
  "gemini-cli": [["gemini", "cli"], ["gemini"]],
};

export function accountProviderName(providerId: string): string {
  return ACCOUNT_PROVIDER_NAMES[providerId] ?? providerId;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/**
 * The account phrase of an account command ("switch to my Gemini B account" → ["gemini", "b"]),
 * or null when the text isn't one. Only "switch", "switch to" and "use" start an account command.
 */
export function parseAccountCommand(text: string): string[] | null {
  const typed = words(text);
  let rest: string[];
  if (typed[0] === "switch") rest = typed[1] === "to" ? typed.slice(2) : typed.slice(1);
  else if (typed[0] === "use") rest = typed.slice(1);
  else return null;
  if (rest[0] === "my" || rest[0] === "the") rest = rest.slice(1);
  if (rest.length > 1 && rest[rest.length - 1] === "account") rest = rest.slice(0, -1);
  return rest.length > 0 ? rest : null;
}

/** Every way the account can be written: its label, and its label after each provider name. */
function spellings(account: ProviderAccount): string[][] {
  const label = words(account.displayName);
  const aliases = PROVIDER_ALIASES[account.providerId] ?? [];
  return [label, ...aliases.map((alias) => [...alias, ...label])];
}

function equal(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((word, i) => word === b[i]);
}

/** The phrase reads as the start of `spelling`; its last word may still be being typed. */
function startsLike(phrase: string[], spelling: string[]): boolean {
  if (phrase.length > spelling.length) return false;
  return phrase.every((word, i) => {
    const target = spelling[i] ?? "";
    return i === phrase.length - 1 ? target.startsWith(word) : target === word;
  });
}

/**
 * Accounts the phrase names, case-insensitively. Exact names win ("codex work" is Codex's
 * "Work"); otherwise every account the phrase could still be ("gemini" → Gemini A and Gemini B).
 * Never picks one of several matches: the palette shows them all.
 */
export function matchAccounts(accounts: readonly ProviderAccount[], phrase: string[]): ProviderAccount[] {
  const active = accounts.filter((account) => account.archivedAt === null);
  const exact = active.filter((account) => spellings(account).some((spelling) => equal(spelling, phrase)));
  if (exact.length > 0) return exact;
  // One or two typed letters ("switch to c") are still a workspace name as often as an account.
  if (phrase.length === 1 && (phrase[0]?.length ?? 0) < 3) return [];
  return active.filter((account) => spellings(account).some((spelling) => startsLike(phrase, spelling)));
}

/** Search words that keep an account item visible for the ways people type it. */
export function accountKeywords(account: ProviderAccount): string[] {
  const label = account.displayName;
  const provider = accountProviderName(account.providerId);
  const short = PROVIDER_ALIASES[account.providerId]?.at(-1)?.join(" ") ?? provider;
  return [
    `switch ${label}`,
    `switch to ${label}`,
    `use ${label}`,
    `switch ${short} ${label}`,
    `switch to ${short} ${label}`,
    `use ${short} ${label}`,
    `use ${provider} ${label}`,
    "account",
  ];
}
