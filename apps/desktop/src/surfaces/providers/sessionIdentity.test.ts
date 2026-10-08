import type { ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { sessionIdentity } from "./sessionIdentity.ts";

const thread = {
  providerId: "cursor",
  providerName: "Cursor",
  providerAccountId: "work",
  accountLabel: "Old nickname",
  model: "requested/model-v1",
  effort: "high",
} as ThreadSummary;
const account = {
  id: "work",
  providerId: "cursor",
  displayName: "Work",
  authenticationState: "authenticated",
  archivedAt: null,
} as ProviderAccount;

describe("canonical session identity", () => {
  it("uses canonical provider names over stale snapshots while retaining future provider names", () => {
    expect(sessionIdentity({ ...thread, providerId: "claude-code", providerName: "Claude" }).providerName).toBe(
      "Claude Code",
    );
    expect(sessionIdentity({ ...thread, providerId: "future-cli", providerName: "Future CLI" }).providerName).toBe(
      "Future CLI",
    );
  });

  it("prefers provider-confirmed model and effort without rewriting configured choices", () => {
    const identity = sessionIdentity({ ...thread, activeModel: "actual/model-v2", activeEffort: "ultra" }, [account]);
    expect(identity.model).toEqual({ value: "actual/model-v2", source: "provider", label: "actual/model-v2" });
    expect(identity.effort).toEqual({ value: "ultra", source: "provider", label: "ultra" });
    expect(identity.accountName).toBe("Work");
    expect(identity.detail).toContain("requested/model-v1");
    expect(thread.model).toBe("requested/model-v1");
  });

  it("labels launch preferences as selected, never as confirmed active identity", () => {
    const identity = sessionIdentity(thread, [account]);
    expect(identity.model.source).toBe("configured");
    expect(identity.model.label).toBe("requested/model-v1 (selected)");
    expect(identity.effort.label).toBe("high (selected)");
    expect(identity.detail).toContain("has not reported");
  });

  it("makes absent provider-controlled facts explicit", () => {
    const identity = sessionIdentity({ ...thread, model: null, effort: null }, [account]);
    expect(identity.model.label).toBe("Model controlled by provider");
    expect(identity.effort.label).toBe("Reasoning controlled by provider");
    expect(identity.model.source).toBe("unavailable");
  });

  it("never borrows identity or usage from another provider or default account", () => {
    const identity = sessionIdentity(thread, [{ ...account, providerId: "codex", displayName: "Wrong" }]);
    expect(identity.account).toBeNull();
    expect(identity.accountName).toBe("Old nickname");
    expect(identity.detail).toContain("Account unavailable");
    expect(identity.detail).not.toContain("Wrong");
  });

  it("preserves expired account identity and explains reconnect without selecting another", () => {
    const identity = sessionIdentity(thread, [
      { ...account, authenticationState: "not_authenticated" },
      { ...account, id: "personal", displayName: "Personal", isDefault: true },
    ]);
    expect(identity.accountName).toBe("Work");
    expect(identity.needsReconnect).toBe(true);
    expect(identity.detail).toContain("Reconnect");
  });

  it("does not invent account identity while restoring or without a binding", () => {
    expect(sessionIdentity(thread, null).accountName).toBe("Old nickname");
    const identity = sessionIdentity({ ...thread, providerAccountId: null, accountLabel: null }, [account]);
    expect(identity.account).toBeNull();
    expect(identity.accountName).toBe("Account unavailable");
  });

  it("keeps future provider model and effort identifiers exact", () => {
    const identity = sessionIdentity(
      {
        ...thread,
        providerId: "future",
        providerName: "Future",
        activeModel: "model/version[reasoning=max]",
        activeEffort: "X-High",
      },
      [],
    );
    expect(identity.providerName).toBe("Future");
    expect(identity.model.value).toBe("model/version[reasoning=max]");
    expect(identity.effort.value).toBe("X-High");
  });
});
