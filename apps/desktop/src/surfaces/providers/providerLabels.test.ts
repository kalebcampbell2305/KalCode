import type { ProviderDetection, ProviderStatus } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { providerCatalog } from "../../ipc/memoryProviders.ts";
import {
  accountSignInHint,
  adapterLabel,
  authLabel,
  capabilityItems,
  detectionLabel,
  fidelityLabel,
  managedSignInLabel,
  modelList,
  needsFirstDetection,
  needsInstall,
  needsSignIn,
  sameSignInLabel,
  settingGroups,
  signInFailureTitle,
  summarizeProviders,
} from "./providerLabels.ts";

const [claude, codex, gemini] = providerCatalog() as [ProviderStatus, ProviderStatus, ProviderStatus];

function detected(status: ProviderStatus, patch: Partial<ProviderDetection>): ProviderStatus {
  return {
    ...status,
    detection: {
      providerId: status.id,
      displayName: status.displayName,
      state: "installed",
      displayPath: "~\\bin\\tool.exe",
      version: "1.2.3",
      minimumVersion: null,
      auth: "authenticated",
      message: null,
      checkedAt: "2026-09-24T00:00:00.000Z",
      ...patch,
    },
  };
}

describe("detectionLabel", () => {
  it("reports each detection state honestly", () => {
    expect(detectionLabel(null)).toEqual({ tone: "idle", label: "Not checked yet", detail: null });
    expect(detectionLabel(detected(claude, {}).detection)).toMatchObject({
      tone: "success",
      label: "Installed, version 1.2.3",
    });
    expect(detectionLabel(detected(claude, { state: "not_installed", version: null }).detection)).toMatchObject({
      tone: "idle",
      label: "Not installed",
    });
  });

  it("explains an outdated version with the minimum", () => {
    const label = detectionLabel(
      detected(claude, { state: "outdated", version: "2.1.100", minimumVersion: "2.1.259" }).detection,
    );
    expect(label).toEqual({
      tone: "waiting",
      label: "Outdated, version 2.1.100",
      detail: "KalCode needs version 2.1.259 or later.",
    });
  });

  it("shows the message and code when a check fails", () => {
    const failed = detected(claude, {
      state: "error",
      version: null,
      message: "The version check didn't finish in time.",
    });
    expect(detectionLabel(failed.detection, "version_timeout")).toEqual({
      tone: "danger",
      label: "Couldn't check",
      detail: "The version check didn't finish in time. Error code: version_timeout.",
    });
  });
});

describe("authLabel", () => {
  it("names the documented command that was used", () => {
    expect(authLabel(detected(codex, { auth: "not_authenticated" }))).toMatchObject({
      tone: "waiting",
      label: "Signed out",
      detail: "Checked with codex login status.",
    });
  });

  it("defers Claude sign-in checks to a real session", () => {
    expect(authLabel(detected(claude, { auth: "unknown" }))).toEqual({
      tone: "idle",
      label: "Sign-in status unknown",
      detail: "Sign-in is checked when a Claude Code session starts.",
    });
  });

  it("says when a provider has no way to check", () => {
    expect(authLabel(detected(gemini, { auth: "unknown" }))).toEqual({
      tone: "idle",
      label: "Sign-in status unknown",
      detail: "Gemini CLI has no documented way to check sign-in without starting a session.",
    });
  });

  it("is not shown before detection or when the CLI is missing", () => {
    expect(authLabel(claude)).toBeNull();
    expect(authLabel(detected(claude, { state: "not_installed" }))).toBeNull();
    expect(authLabel(detected(claude, { state: "error" }))).toBeNull();
  });

  it("never reports a connected state", () => {
    for (const auth of ["authenticated", "not_authenticated", "unknown"] as const) {
      expect(authLabel(detected(claude, { auth }))?.label).not.toMatch(/connect/i);
    }
  });
});

describe("guidance", () => {
  it("asks to sign in only for an installed CLI that isn't known to be signed in", () => {
    expect(needsSignIn(detected(claude, {}))).toBe(false);
    expect(needsSignIn(detected(claude, { auth: "not_authenticated" }))).toBe(true);
    expect(needsSignIn(detected(gemini, { auth: "unknown" }))).toBe(true);
    expect(needsSignIn(detected(claude, { state: "not_installed", auth: "unknown" }))).toBe(false);
    expect(needsSignIn(claude)).toBe(false);
  });

  it("explains the managed sign-in in one line, never as a terminal command", () => {
    expect(accountSignInHint(gemini)).toBe("Gemini opens Google sign-in in your browser for that account only.");
    expect(accountSignInHint(claude)).toBe("Claude Code opens its sign-in in your browser for that account only.");
    expect(accountSignInHint(codex)).toBe("Codex opens ChatGPT sign-in in your browser for that account only.");
    for (const status of [gemini, claude, codex]) expect(accountSignInHint(status)).not.toMatch(/^Run |terminal/);
    expect(accountSignInHint({ id: "other-cli", displayName: "Other" })).toBeNull();
  });

  it("reads managed sign-in from KalCode's accounts, the same state the Accounts tab shows", () => {
    const signedIn = { authenticationState: "authenticated" } as const;
    const signedOut = { authenticationState: "not_authenticated" } as const;
    expect(managedSignInLabel(null)).toBeNull();
    expect(managedSignInLabel([])).toEqual({ tone: "idle", label: "No account yet", detail: null });
    expect(managedSignInLabel([signedOut])).toEqual({ tone: "waiting", label: "Not signed in", detail: null });
    expect(managedSignInLabel([signedIn, signedOut])?.label).toBe("Signed in (1 account)");
    expect(managedSignInLabel([signedIn, signedIn, signedOut])).toEqual({
      tone: "success",
      label: "Signed in (2 accounts)",
      detail: null,
    });
  });

  it("names the other account when two accounts share one provider sign-in", () => {
    const row = (id: string, displayName: string, identity: string | null, extra = {}) => ({
      id,
      providerId: "codex",
      displayName,
      providerReportedIdentity: identity,
      isDefault: false,
      archivedAt: null,
      ...extra,
    });
    const personal = row("a", "Personal", "me@example.com", { isDefault: true });
    const work = row("b", "Work", " ME@example.com ");
    const side = row("c", "Side", "other@example.com");
    const claude = row("d", "Claude", "me@example.com", { providerId: "claude-code" });
    const all = [personal, work, side, claude];
    expect(sameSignInLabel(work, all)).toBe("Same sign-in as Personal");
    expect(sameSignInLabel(personal, all)).toBe("Same sign-in as Work");
    expect(sameSignInLabel(side, all)).toBeNull();
    expect(sameSignInLabel(row("e", "Unknown", null), all)).toBeNull();
    expect(sameSignInLabel(row("f", "Third", "me@example.com"), all)).toBe("Same sign-in as Personal +1");
    expect(
      sameSignInLabel(
        work,
        [personal, work].map((a) => ({ ...a, archivedAt: "2026-10-01T00:00:00Z" })),
      ),
    ).toBeNull();
  });

  it("offers install guidance only when the CLI is missing", () => {
    expect(needsInstall(detected(codex, { state: "not_installed" }))).toBe(true);
    expect(needsInstall(detected(codex, {}))).toBe(false);
    expect(needsInstall(codex)).toBe(false);
  });
});

describe("static labels", () => {
  it("labels fidelity and adapter state in plain language", () => {
    expect(fidelityLabel("approximate_stricter")).toBe("Stricter than requested");
    expect(fidelityLabel("exact")).toBe("Exact");
    expect(fidelityLabel("unsupported")).toBe("Not supported");
    expect(adapterLabel("implemented").badge).toBe("Adapter ready");
    expect(adapterLabel("planned").description).toBe(
      "Detection only. Threads can't use it until KalCode's adapter for it ships.",
    );
  });

  it("lists capabilities as yes/no items", () => {
    expect(capabilityItems(claude.capabilities).map((c) => [c.label, c.supported])).toEqual([
      ["Streaming", true],
      ["Interrupt", true],
      ["Resume", true],
      ["Host approvals", false],
    ]);
  });

  it("shows documented model aliases only", () => {
    expect(modelList(claude)).toBe("Account default (default), Opus, Sonnet, Haiku, Fable");
    expect(modelList(codex)).toBeNull();
  });

  it("keeps each flag with its value", () => {
    expect(settingGroups("--setting-sources user --permission-mode acceptEdits --permission-prompts none")).toEqual([
      "--setting-sources user",
      "--permission-mode acceptEdits",
      "--permission-prompts none",
    ]);
    expect(settingGroups("--restricted --permission-mode plan")).toEqual(["--restricted", "--permission-mode plan"]);
  });
});

describe("summarizeProviders", () => {
  it("is unchecked until detection has run", () => {
    expect(summarizeProviders([claude, codex, gemini])).toEqual({
      checked: false,
      installed: 0,
      total: 3,
      installedNames: [],
    });
    expect(needsFirstDetection([claude])).toBe(true);
  });

  it("counts installed and outdated CLIs", () => {
    const statuses = [
      detected(claude, { state: "outdated" }),
      detected(codex, {}),
      detected(gemini, { state: "not_installed" }),
    ];
    expect(summarizeProviders(statuses)).toEqual({
      checked: true,
      installed: 2,
      total: 3,
      installedNames: ["Claude Code", "Codex"],
    });
    expect(needsFirstDetection(statuses)).toBe(false);
  });
});

describe("signInFailureTitle", () => {
  it("names an unsupported CLI release instead of a generic sign-in failure", () => {
    expect(signInFailureTitle("Claude Code", "provider_version_unsupported")).toBe(
      "Claude Code version isn't supported yet",
    );
    expect(signInFailureTitle("Codex", "provider_version_unsupported")).toBe("Codex version isn't supported yet");
  });

  it("keeps the sign-in title for every other failure", () => {
    expect(signInFailureTitle("Claude Code", "provider_auth_failed")).toBe("Claude Code sign-in didn't finish");
    expect(signInFailureTitle("Gemini", "provider_login_timed_out")).toBe("Gemini sign-in didn't finish");
  });
});
