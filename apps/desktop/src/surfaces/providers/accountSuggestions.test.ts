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

it("suggests on known sign-in failures but never treats a passive metadata failure as lost authentication", () => {
  expect(suggest([account("a", { authenticationState: "not_authenticated" }), account("b")], [])?.reason).toBe(
    "A needs sign-in.",
  );
  expect(suggest([account("b")], [])?.reason).toContain("no longer available");
  expect(suggest(undefined, [], thread, new Set(), new Map([["a", "refresh failed"]]))).toBeNull();
  expect(suggest([account("a", { lastErrorCode: "provider_error" }), account("b")], [])).toBeNull();
});

it("excludes foreign, archived, expired, unknown-auth and low accounts while preserving known sign-in", () => {
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
  expect(result?.alternatives.map((item) => item.account.id)).toEqual(["checking", "error", "good", "validation"]);
  expect(result?.alternatives[0]?.detail).toContain("Checking account");
  expect(result?.alternatives[1]?.detail).toContain("Account check incomplete");
});

it("distinguishes tiny positive quota from an actual provider-reported zero", () => {
  expect(suggest(undefined, [usage("a", 0.1)])?.reason).toContain("<1% left");
  expect(suggest(undefined, [usage("a", 0)])?.reason).toContain("0% left");
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

it("uses a structured native turn failure without fabricating quota or carrying it into a resumed turn", () => {
  const failed = {
    ...thread,
    status: "idle",
    currentActivity: "Last turn failed",
    error: { code: "provider_rate_limit", message: "provider output" },
  } as ThreadSummary;
  const result = suggest(undefined, [], failed);
  expect(result?.reason).toBe("A reached a provider-reported limit.");
  expect(result?.reason).not.toContain("%");
  expect(suggest(undefined, [], { ...failed, status: "active" })).toBeNull();
  expect(suggest(undefined, [], { ...failed, currentActivity: null })).toBeNull();
  expect(suggest(undefined, [], { ...failed, error: { code: "unrelated", message: "rate limit" } })).toBeNull();
});

it.each([
  ["provider_authentication_failed", "sign-in"],
  ["provider_oauth_org_not_allowed", "sign-in"],
  ["provider_billing_error", "billing"],
  ["provider_account_on_hold", "billing"],
])("recognizes structured %s with no numeric usage", (code, condition) => {
  expect(suggest(undefined, [], { ...thread, status: "failed", error: { code, message: "failure" } })?.condition).toBe(
    condition,
  );
});

it("ignores another model's weekly limit but honours it for that model (#284)", () => {
  const fableLow = usage("a", 0, {
    windows: [
      { id: "weekly", label: "Weekly", remainingPercent: 80, resetsAt: null },
      { id: "weekly_fable", label: "Weekly Fable", remainingPercent: 2, resetsAt: null },
    ],
  });
  const readings = [fableLow, usage("b", 90)];
  for (const model of ["claude-sonnet-4-6", "claude-opus-4-6"])
    expect(suggest(undefined, readings, { ...thread, model } as ThreadSummary)).toBeNull();
  const fable = suggest(undefined, readings, { ...thread, model: "claude-fable-1" } as ThreadSummary);
  expect(fable?.condition).toBe("low");
  expect(fable?.reason).toBe("A has 2% left in its weekly fable limit.");
});

it("reports a positive fraction under 1% as <1%, never 0% (#284)", () => {
  expect(suggest(undefined, [usage("a", 0.4), usage("b", 80)])?.reason).toBe("A has <1% left in its weekly limit.");
});
