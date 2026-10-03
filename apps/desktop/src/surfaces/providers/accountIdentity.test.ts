import { describe, expect, it } from "vitest";
import {
  accountFullLabel,
  accountHealth,
  accountInlineLabel,
  accountName,
  accountSessionState,
  accountSignIn,
  sortAccounts,
} from "./accountIdentity.ts";

describe("account identity", () => {
  it("names an account the same way everywhere", () => {
    const account = { providerId: "claude-code", displayName: "Work" };
    expect(accountName(account)).toBe("Work");
    expect(accountFullLabel(account)).toBe("Claude Code · Work");
    expect(accountInlineLabel(account)).toBe("Work (Claude Code)");
    expect(accountFullLabel({ providerId: "codex", displayName: "  " })).toBe("Codex · Unnamed account");
  });

  it("reports sign-in only as last checked", () => {
    expect(accountSignIn({ authenticationState: "authenticated" }).label).toBe("Signed in");
    expect(accountSignIn({ authenticationState: "not_authenticated" }).label).toBe("Signed out");
    expect(accountSignIn({ authenticationState: "unknown" }).label).toBe("Not checked");
  });

  it("derives health from the last check and error", () => {
    const base = { authenticationState: "authenticated" as const, lastErrorCode: null, lastCheckedAt: "2026-10-01" };
    expect(accountHealth(base).label).toBe("Healthy");
    expect(accountHealth({ ...base, lastErrorCode: "auth_expired" }).label).toBe("Needs attention");
    expect(accountHealth({ ...base, authenticationState: "unknown", lastCheckedAt: null }).label).toBe("Not checked");
  });

  it("distinguishes restart-safe session states without discarding known usability", () => {
    const connected = {
      authenticationState: "authenticated" as const,
      lastErrorCode: null,
      lastCheckedAt: "2026-10-01T00:00:00.000Z",
    };
    expect(accountSessionState(connected)).toMatchObject({ state: "connected", label: "Connected", usable: true });
    expect(accountSessionState(connected, true)).toMatchObject({ state: "checking", label: "Checking", usable: true });
    expect(accountSessionState(connected, false, "Provider unavailable")).toMatchObject({
      state: "error",
      label: "Error",
      usable: true,
    });
    expect(
      accountSessionState(
        { ...connected, authenticationState: "unknown", lastCheckedAt: null },
        false,
        "Provider unavailable",
      ),
    ).toMatchObject({ state: "error", label: "Error", usable: true });
    expect(
      accountSessionState({
        ...connected,
        authenticationState: "not_authenticated",
        lastErrorCode: "auth_expired",
      }),
    ).toMatchObject({ state: "expired", label: "Expired", usable: false });
  });

  it("sorts default first, then names in natural order", () => {
    const sorted = sortAccounts([
      { displayName: "Claude 10", isDefault: false },
      { displayName: "Claude 2", isDefault: false },
      { displayName: "Claude 3", isDefault: true },
      { displayName: "claude 1", isDefault: false },
    ]);
    expect(sorted.map((account) => account.displayName)).toEqual(["Claude 3", "claude 1", "Claude 2", "Claude 10"]);
  });
});
