import type { ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { expect, it } from "vitest";
import { suggestAccounts } from "./accountSuggestions.ts";
import type { AccountUsageState } from "./accountUsage.ts";

const now = Date.parse("2026-10-04T22:00:00Z");
const thread = {
  providerId: "claude-code",
  providerAccountId: "a",
  model: "claude-sonnet-4-6",
  permissionMode: "plan",
  archivedAt: null,
} as ThreadSummary;
const account = (id: string, overrides: Partial<ProviderAccount> = {}) =>
  ({
    id,
    displayName: id.toUpperCase(),
    providerId: "claude-code",
    archivedAt: null,
    authenticationState: "authenticated",
    lastErrorCode: null,
    isDefault: false,
    ...overrides,
  }) as ProviderAccount;
const usage = (
  accountId: string,
  remainingPercent: number,
  overrides: Partial<AccountUsageState> = {},
): AccountUsageState => ({
  accountId,
  status: "fresh",
  checkedAt: new Date(now).toISOString(),
  reason: null,
  windows: [{ id: "weekly", label: "Weekly", remainingPercent, resetsAt: null }],
  ...overrides,
});
const suggest = (
  accounts = [account("a"), account("b")],
  readings = [usage("a", 10), usage("b", 80)],
  source = thread,
  checking = new Set<string>(),
  errors = new Map<string, string>(),
) =>
  suggestAccounts(
    source,
    accounts,
    new Map(readings.map((reading) => [reading.accountId, reading])),
    checking,
    errors,
    now,
  );

it("uses real low usage and ranks known headroom, explicit default, then name without quota guesses", () => {
  const result = suggest(
    [account("a"), account("z", { isDefault: true }), account("c"), account("b"), account("unknown")],
    [usage("a", 10), usage("b", 80), usage("c", 90), usage("z", 21)],
  );
  expect(result?.reason).toBe("A has 10% left in its weekly limit.");
  expect(result?.alternatives.map((item) => item.account.id)).toEqual(["z", "b", "c", "unknown"]);
  expect(result?.alternatives.at(-1)?.detail).toContain("Usage unavailable");
});

it.each(["stale", "checking", "unavailable", "not_checked"] as const)(
  "does not infer a limit from %s usage",
  (status) => {
    expect(suggest(undefined, [usage("a", 0, { status })])).toBeNull();
  },
);

it("ignores old, future, reset, malformed and other-model quota data", () => {
  for (const reading of [
    usage("a", 0, { checkedAt: new Date(now - 16 * 60_000).toISOString() }),
    usage("a", 0, { checkedAt: new Date(now + 1).toISOString() }),
    usage("a", 0, { checkedAt: null }),
    usage("a", Number.NaN),
    usage("a", -1),
    usage("a", 110),
    usage("a", 0, {
      windows: [{ id: "weekly", label: "Weekly", remainingPercent: 0, resetsAt: new Date(now).toISOString() }],
    }),
    usage("a", 0, { windows: [{ id: "weekly_opus", label: "Weekly Opus", remainingPercent: 0, resetsAt: null }] }),
  ])
    expect(suggest(undefined, [reading])).toBeNull();
  expect(suggest(undefined, [usage("a", 20)])).toBeNull();
});

it("suggests on known sign-in or connection failures even without exposed usage", () => {
  expect(suggest([account("a", { authenticationState: "not_authenticated" }), account("b")], [])?.reason).toBe(
    "A needs sign-in.",
  );
  expect(suggest([account("b")], [])?.reason).toContain("no longer available");
  expect(suggest(undefined, [], thread, new Set(), new Map([["a", "refresh failed"]]))?.reason).toContain(
    "connection error",
  );
});

it("excludes foreign, archived, expired, checking, errored, unknown-auth and low accounts", () => {
  const result = suggest(
    [
      account("a"),
      account("good"),
      account("foreign", { providerId: "codex" }),
      account("archived", { archivedAt: "today" }),
      account("expired", { authenticationState: "not_authenticated" }),
      account("checking"),
      account("error", { lastErrorCode: "provider_error" }),
      account("validation"),
      account("unknown", { authenticationState: "unknown" }),
      account("low"),
      account("empty"),
    ],
    [usage("a", 10), usage("low", 19), usage("empty", 0)],
    thread,
    new Set(["checking"]),
    new Map([["validation", "failed"]]),
  );
  expect(result?.alternatives.map((item) => item.account.id)).toEqual(["good"]);
});

it("never uses another account's quota even when the map key is incorrect", () => {
  expect(
    suggestAccounts(thread, [account("a"), account("b")], new Map([["a", usage("b", 0)]]), new Set(), new Map(), now),
  ).toBeNull();
});

it("does not suggest a launch for unmanaged, archived or custom-permission sessions", () => {
  for (const overrides of [{ providerAccountId: null }, { archivedAt: "today" }, { permissionMode: "custom" }])
    expect(suggest(undefined, undefined, { ...thread, ...overrides } as ThreadSummary)).toBeNull();
});
