import type { ApprovalView, PermissionMode, PermissionSettings } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionsProvider, usePermissions } from "./PermissionsProvider.tsx";

const runtime = vi.hoisted(() => ({ client: {} as ReturnType<typeof makeClient>, events: [] }));
const toast = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => runtime,
  useEvents: () => runtime,
}));
vi.mock("@kalcode/ui/components", () => ({ useToast: () => toast }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function settings(defaultMode: PermissionMode = "approve"): PermissionSettings {
  return { defaultMode, defaultProfileId: null };
}

function approval(id = "request-1"): ApprovalView {
  return {
    id,
    action: {
      id: "action-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      providerId: "claude-code",
      action: { kind: "command", command: "npm test", argv: [], cwd: "" },
      summary: "Run tests",
      requestedAt: "2026-09-25T00:00:00Z",
      origin: null,
    },
    decision: { effect: "ask", scopes: [], reason: "Approval required", approvable: true },
    permissionMode: "approve",
    status: "pending",
    resolvedDecision: null,
    resolvedAt: null,
    allowedDecisions: ["deny", "approve_once"],
    grantCoverage: "Run tests",
    context: { threadName: "Tests", workspaceName: "Workspace", providerName: "Claude Code" },
    createdAt: "2026-09-25T00:00:00Z",
    expireReason: null,
  };
}

function makeClient() {
  return {
    listApprovals: vi.fn(async () => [] as ApprovalView[]),
    getPermissionSettings: vi.fn(async () => settings()),
    listPermissionProfiles: vi.fn(async () => [
      { id: "profile", name: "Default", mode: "approve" as const, rules: [], builtin: true },
    ]),
    decideApproval: vi.fn(
      async (_id: string, _decision: string): Promise<ApprovalView> => ({ ...approval(), status: "approved" }),
    ),
    updatePermissionSettings: vi.fn(async (mode: PermissionMode, _options: unknown) => settings(mode)),
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <PermissionsProvider>{children}</PermissionsProvider>
    </StrictMode>
  );
}

beforeEach(() => {
  runtime.client = makeClient();
  runtime.events = [];
  toast.show.mockReset();
});

describe("permission state lifetime", () => {
  it("does not restore an answered request from an earlier pending read", async () => {
    const row = approval();
    runtime.client.listApprovals.mockResolvedValue([row]);
    const { result } = renderHook(usePermissions, { wrapper });
    await waitFor(() => expect(result.current.pending).toEqual([row]));
    const stale = deferred<ApprovalView[]>();
    runtime.client.listApprovals.mockReturnValueOnce(stale.promise);
    let reading!: Promise<void>;
    act(() => {
      reading = result.current.refreshPending();
    });
    runtime.client.listApprovals.mockResolvedValue([]);
    await act(() => result.current.decide(row.id, "approve_once"));
    expect(result.current.pending).toEqual([]);
    await act(async () => {
      stale.resolve([row]);
      await reading;
    });
    expect(result.current.pending).toEqual([]);
  });

  it("clears the old runtime's requests, settings, profiles and panel while the new runtime loads", async () => {
    runtime.client.listApprovals.mockResolvedValue([approval()]);
    const { result, rerender } = renderHook(usePermissions, { wrapper });
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    act(() => result.current.setPanelOpen(true));
    const next = makeClient();
    next.listApprovals.mockReturnValue(new Promise(() => {}));
    next.getPermissionSettings.mockReturnValue(new Promise(() => {}));
    runtime.client = next;
    rerender();
    expect(result.current.pending).toEqual([]);
    expect(result.current.pendingState).toBe("loading");
    expect(result.current.settings).toBeNull();
    expect(result.current.profiles).toEqual([]);
    expect(result.current.panelOpen).toBe(false);
  });

  it("ignores an old decision completion even when the new runtime uses the same request ID", async () => {
    runtime.client.listApprovals.mockResolvedValue([approval()]);
    const answer = deferred<ApprovalView>();
    runtime.client.decideApproval.mockReturnValue(answer.promise);
    const { result, rerender } = renderHook(usePermissions, { wrapper });
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    let deciding!: Promise<ApprovalView | null>;
    act(() => {
      deciding = result.current.decide("request-1", "deny");
    });
    runtime.client = makeClient();
    runtime.client.listApprovals.mockResolvedValue([approval()]);
    rerender();
    await waitFor(() => expect(runtime.client.listApprovals).toHaveBeenCalled());
    await act(async () => {
      answer.resolve({ ...approval(), status: "denied" });
    });
    expect(await deciding).toBeNull();
    expect(result.current.pending).toHaveLength(1);
  });

  it("does not invoke native calls through callbacks retained from an obsolete runtime", async () => {
    const old = runtime.client;
    const { result, rerender } = renderHook(usePermissions, { wrapper });
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    const retained = result.current;
    runtime.client = makeClient();
    rerender();
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    const reads = old.listApprovals.mock.calls.length;
    await act(async () => {
      expect(await retained.decide("request-1", "approve_once")).toBeNull();
      expect(await retained.setDefaultMode("bypass", { confirmed: true })).toBe(false);
      await retained.refreshPending();
    });
    expect(old.decideApproval).not.toHaveBeenCalled();
    expect(old.updatePermissionSettings).not.toHaveBeenCalled();
    expect(old.listApprovals).toHaveBeenCalledTimes(reads);
  });

  it("ignores old decision failures without showing a toast or launching another read", async () => {
    const old = runtime.client;
    const answer = deferred<ApprovalView>();
    old.decideApproval.mockReturnValue(answer.promise);
    const { result, rerender } = renderHook(usePermissions, { wrapper });
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    let deciding!: Promise<ApprovalView | null>;
    act(() => {
      deciding = result.current.decide("request-1", "deny");
    });
    runtime.client = makeClient();
    rerender();
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    const reads = old.listApprovals.mock.calls.length;
    await act(async () => {
      answer.reject(new Error("old runtime failure"));
      await deciding;
    });
    expect(toast.show).not.toHaveBeenCalled();
    expect(old.listApprovals).toHaveBeenCalledTimes(reads);
  });

  it("orders native mode changes and preserves explicit bypass confirmation", async () => {
    const first = deferred<PermissionSettings>();
    const client = runtime.client;
    client.updatePermissionSettings.mockReturnValueOnce(first.promise);
    const { result } = renderHook(usePermissions, { wrapper });
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    let earlier!: Promise<boolean>;
    let latest!: Promise<boolean>;
    await act(async () => {
      earlier = result.current.setDefaultMode("bypass", { confirmed: true });
      latest = result.current.setDefaultMode("approve");
    });
    expect(client.updatePermissionSettings).toHaveBeenCalledTimes(1);
    expect(client.updatePermissionSettings).toHaveBeenNthCalledWith(1, "bypass", {
      profileId: null,
      confirmBypass: true,
    });
    await act(async () => {
      first.resolve(settings("bypass"));
      await earlier;
      await latest;
    });
    expect(client.updatePermissionSettings).toHaveBeenNthCalledWith(2, "approve", {
      profileId: null,
      confirmBypass: undefined,
    });
    expect(result.current.settings?.defaultMode).toBe("approve");
  });

  it("does not let initial settings overwrite a completed mode change", async () => {
    const initial = deferred<PermissionSettings>();
    runtime.client.getPermissionSettings.mockReturnValue(initial.promise);
    const { result } = renderHook(usePermissions, { wrapper });
    await act(() => result.current.setDefaultMode("auto"));
    await act(async () => {
      initial.resolve(settings());
    });
    expect(result.current.settings?.defaultMode).toBe("auto");
    expect(result.current.profiles).toHaveLength(1);
  });

  it("ignores a mode update completing after unmount", async () => {
    const update = deferred<PermissionSettings>();
    runtime.client.updatePermissionSettings.mockReturnValue(update.promise);
    const { result, unmount } = renderHook(usePermissions, { wrapper });
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    let changing!: Promise<boolean>;
    await act(async () => {
      changing = result.current.setDefaultMode("auto");
    });
    unmount();
    update.resolve(settings("auto"));
    expect(await changing).toBe(false);
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("drops queued old-runtime mode changes without delaying the new runtime", async () => {
    const old = runtime.client;
    const update = deferred<PermissionSettings>();
    old.updatePermissionSettings.mockReturnValueOnce(update.promise);
    const { result, rerender } = renderHook(usePermissions, { wrapper });
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    let first!: Promise<boolean>;
    let queued!: Promise<boolean>;
    await act(async () => {
      first = result.current.setDefaultMode("auto");
      queued = result.current.setDefaultMode("bypass", { confirmed: true });
    });
    runtime.client = makeClient();
    rerender();
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(() => result.current.setDefaultMode("plan"));
    await act(async () => {
      update.resolve(settings("auto"));
    });
    expect(await first).toBe(false);
    expect(await queued).toBe(false);
    expect(old.updatePermissionSettings).toHaveBeenCalledTimes(1);
    expect(result.current.settings?.defaultMode).toBe("plan");
  });

  it("reconciles failed mode changes without blocking or overwriting a newer write", async () => {
    const client = runtime.client;
    const { result } = renderHook(usePermissions, { wrapper });
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    const reconcile = deferred<PermissionSettings>();
    client.getPermissionSettings.mockReturnValueOnce(reconcile.promise);
    client.updatePermissionSettings.mockRejectedValueOnce(new Error("write failed"));
    await act(async () => {
      expect(await result.current.setDefaultMode("auto")).toBe(false);
    });
    expect(result.current.settings).toBeNull();
    expect(toast.show).toHaveBeenCalledWith(expect.objectContaining({ title: "Permission mode not changed" }));
    await act(() => result.current.setDefaultMode("plan"));
    await act(async () => {
      reconcile.resolve(settings());
    });
    expect(result.current.settings?.defaultMode).toBe("plan");
  });

  it("reads the actual mode if the last queued write fails after an earlier one succeeded", async () => {
    const client = runtime.client;
    const { result } = renderHook(usePermissions, { wrapper });
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    client.updatePermissionSettings.mockResolvedValueOnce(settings("bypass"));
    client.updatePermissionSettings.mockRejectedValueOnce(new Error("failed to switch back"));
    client.getPermissionSettings.mockResolvedValue(settings("bypass"));
    await act(async () => {
      await Promise.all([
        result.current.setDefaultMode("bypass", { confirmed: true }),
        result.current.setDefaultMode("approve"),
      ]);
    });
    expect(result.current.settings?.defaultMode).toBe("bypass");
  });

  it("never supplies bypass confirmation unless the caller explicitly confirmed it", async () => {
    const { result } = renderHook(usePermissions, { wrapper });
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(() => result.current.setDefaultMode("bypass"));
    expect(runtime.client.updatePermissionSettings).toHaveBeenCalledWith("bypass", {
      profileId: null,
      confirmBypass: false,
    });
  });

  it("keeps the newer pending list when an older read fails", async () => {
    const { result } = renderHook(usePermissions, { wrapper });
    await waitFor(() => expect(result.current.pendingState).toBe("ready"));
    const old = deferred<ApprovalView[]>();
    runtime.client.listApprovals.mockReturnValueOnce(old.promise);
    let first!: Promise<void>;
    act(() => {
      first = result.current.refreshPending();
    });
    runtime.client.listApprovals.mockResolvedValue([approval("new-request")]);
    await act(() => result.current.refreshPending());
    await act(async () => {
      old.reject(new Error("obsolete read"));
      await first;
    });
    expect(result.current.pending[0]?.id).toBe("new-request");
    expect(result.current.pendingState).toBe("ready");
    expect(result.current.pendingError).toBeNull();
  });

  it("re-reads pending requests and reports a current decision failure", async () => {
    runtime.client.listApprovals.mockResolvedValue([approval()]);
    const { result } = renderHook(usePermissions, { wrapper });
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    runtime.client.decideApproval.mockRejectedValueOnce(new Error("native denial"));
    runtime.client.listApprovals.mockResolvedValue([]);
    await act(async () => {
      expect(await result.current.decide("request-1", "approve_once")).toBeNull();
    });
    expect(result.current.pending).toEqual([]);
    expect(toast.show).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't record your answer" }));
    // The toast's "Try again" re-sends the same answer.
    const shown = toast.show.mock.calls.at(-1)?.[0] as { action?: { label: string; onSelect: () => void } };
    expect(shown.action?.label).toBe("Try again");
    runtime.client.decideApproval.mockClear();
    await act(async () => shown.action?.onSelect());
    expect(runtime.client.decideApproval).toHaveBeenCalledWith("request-1", "approve_once");
  });
});
