import type { HandoffPreview, HandoffRecord, ThreadSummary } from "@kalcode/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KalCodeClient } from "../../ipc/client.ts";
import { HandOffDialog } from "./HandOffDialog.tsx";

const runtime = vi.hoisted(() => ({ client: null as unknown as KalCodeClient }));
const agents = vi.hoisted(() => ({
  state: { status: "ready", data: [] as unknown[] } as { status: string; data?: unknown[]; error?: unknown },
  reload: () => {},
}));
const providerSessions = vi.hoisted(() => ({
  accounts: [
    {
      id: "source-account",
      providerId: "claude-code",
      displayName: "Source Work",
      authenticationState: "authenticated",
      archivedAt: null,
    },
    {
      id: "target-account",
      providerId: "claude-code",
      displayName: "Review Work",
      authenticationState: "authenticated",
      archivedAt: null,
    },
  ],
}));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime }));
vi.mock("../../account/AccountProvider.tsx", () => ({ useOptionalAccount: () => null }));
vi.mock("../../runtime/uiIntents.tsx", () => ({ useOptionalUiIntents: () => null }));
vi.mock("../../shell/navigation.tsx", () => ({ useNavigation: () => ({ navigate: () => {} }) }));
vi.mock("../../shell/AccountHub.tsx", () => ({ HUB_SECTIONS: { account: "account" } }));
vi.mock("../dashboard/data/DashboardData.tsx", () => ({ useCodingAgents: () => agents }));
vi.mock("../providers/ProviderAccountSessions.tsx", () => ({
  useOptionalProviderAccountSessions: () => providerSessions,
}));

const agent = (id: string, name: string, createdAt: string): ThreadSummary =>
  ({
    id,
    name,
    providerId: "claude-code",
    providerName: "Claude Code",
    workspaceId: "ws",
    workspaceName: "handoff-project",
    status: "idle",
    createdAt,
    lastActivityAt: createdAt,
    runtimeKind: "interactive_pty",
  }) as unknown as ThreadSummary;

const SOURCE = agent("source", "Implement Dashboard", "2026-10-01T00:00:00.000Z");
const TARGET = agent("target", "Review Dashboard", "2026-10-01T00:01:00.000Z");
Object.assign(SOURCE, {
  providerAccountId: "source-account",
  accountLabel: "Old source",
  model: "selected/source-v1",
  effort: "high",
  activeModel: "provider/source-v2",
  activeEffort: "X-High",
});
Object.assign(TARGET, {
  providerAccountId: "target-account",
  accountLabel: "Old target",
  model: "selected/review-v1",
  effort: "medium",
  activeModel: "provider/review-v3[reasoning=max]",
  activeEffort: "Max",
});

const record = (status: HandoffRecord["status"]): HandoffRecord => ({
  id: `h-${status}`,
  sourceThreadId: SOURCE.id,
  targetThreadId: TARGET.id,
  sourceWorkspaceId: "ws",
  targetWorkspaceId: "ws",
  sourceName: SOURCE.name,
  targetName: TARGET.name,
  task: "review",
  status,
  createdAt: "2026-10-01T00:02:00.000Z",
  updatedAt: "2026-10-01T00:02:00.000Z",
  result: null,
  blocker: null,
  sourceCommit: null,
  sourceBranch: null,
  returnOfId: null,
});

const preview: HandoffPreview = {
  id: "p1",
  sourceThreadId: SOURCE.id,
  targetThreadId: TARGET.id,
  task: "review",
  text: "Task: review",
  previewHash: "hash",
  sourceCommit: null,
  sourceBranch: null,
  sourceDirty: false,
  warnings: [],
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
};

function client(handoffs: Partial<KalCodeClient["handoffs"]>) {
  runtime.client = {
    handoffs: {
      list: vi.fn(async () => []),
      preview: vi.fn(async () => preview),
      send: vi.fn(),
      cancel: vi.fn(),
      complete: vi.fn(),
      returnFindings: vi.fn(),
      ...handoffs,
    },
  } as unknown as KalCodeClient;
  return runtime.client.handoffs;
}

const dialog = () => render(<HandOffDialog open source={SOURCE} onNewAgent={() => {}} onClose={() => {}} />);

beforeEach(() => {
  agents.state = { status: "ready", data: [SOURCE, TARGET] };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HandOffDialog", () => {
  it("shows canonical source and recipient provider, account, model and reasoning identity", async () => {
    client({});
    dialog();

    expect(screen.getByText("Claude Code · Source Work · provider/source-v2 · X-High")).toBeVisible();
    const group = await screen.findByRole("group", { name: "Handoff recipient" });
    const recipient = within(group).getByRole("radio").closest("label");
    expect(recipient).toHaveTextContent("Review Dashboard");
    expect(recipient).toHaveTextContent("Claude Code · Review Work · provider/review-v3[reasoning=max] · Max");
    expect(recipient?.querySelector("[data-handoff-recipient-identity]")).toHaveAttribute(
      "title",
      expect.stringContaining("Selected model: selected/review-v1."),
    );
  });

  it("preselects the only valid recipient so Prepare is one click away", async () => {
    client({});
    dialog();
    const group = await screen.findByRole("group", { name: "Handoff recipient" });
    const radio = within(group).getByRole("radio");
    expect(radio).toBeChecked();
    expect(screen.getByRole("button", { name: "Prepare handoff" })).toBeEnabled();
  });

  it("asks for a recipient when there is more than one", async () => {
    agents.state = { status: "ready", data: [SOURCE, TARGET, agent("third", "Claude C", "2026-10-01T00:03:00.000Z")] };
    client({});
    dialog();
    const group = await screen.findByRole("group", { name: "Handoff recipient" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    for (const radio of radios) expect(radio).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Prepare handoff" })).toBeDisabled();
  });

  it("loads activity once and does not poll settled history", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = client({ list: vi.fn(async () => [record("completed")]) });
    dialog();
    await screen.findByText(/To Review Dashboard/);
    await act(async () => {
      vi.advanceTimersByTime(8_000);
    });
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("polls quietly while a handoff is live, without flashing back to loading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = client({ list: vi.fn(async () => [record("delivered")]) });
    dialog();
    await screen.findByText(/To Review Dashboard/);
    await act(async () => {
      vi.advanceTimersByTime(2_600);
    });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("status", { name: "Loading handoffs" })).not.toBeInTheDocument();
    expect(screen.getByText(/To Review Dashboard/)).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(2_600);
    });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(3));
  });

  it("offers Try again when handoff activity can't load", async () => {
    const list = vi
      .fn<KalCodeClient["handoffs"]["list"]>()
      .mockRejectedValueOnce({ category: "internal", code: "x", message: "Activity is unavailable.", retryable: true })
      .mockResolvedValue([]);
    client({ list });
    dialog();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Activity is unavailable.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No handoffs for this agent yet.");
  });

  it("a failed send says what happened and offers Prepare again or another agent", async () => {
    const send = vi.fn(async () => {
      throw { category: "validation", code: "handoff_preview_stale", message: "Preview expired.", retryable: true };
    });
    const api = client({ send });
    dialog();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Prepare handoff" }));
    await user.click(await screen.findByRole("button", { name: "Send handoff" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Preview expired.");
    expect(screen.getByRole("button", { name: "Choose another agent" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Prepare again" }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    expect(api.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetThreadId: TARGET.id, editedText: preview.text, priorPreviewId: preview.id }),
    );
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Choose a recipient" })).toBeInTheDocument();
  });

  it("reloads activity after a failed send so a record created before the failure is visible", async () => {
    const created = record("queued");
    const list = vi.fn<KalCodeClient["handoffs"]["list"]>().mockResolvedValueOnce([]).mockResolvedValue([created]);
    const send = vi.fn(async () => {
      throw { category: "internal", code: "x", message: "Send failed.", retryable: false };
    });
    client({ list, send });
    dialog();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Prepare handoff" }));
    await user.click(await screen.findByRole("button", { name: "Send handoff" }));
    expect(await screen.findByRole("button", { name: "Cancel queued handoff to Review Dashboard" })).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps every live handoff visible and trims only settled history", async () => {
    const settled = Array.from({ length: 10 }, (_, index) => ({
      ...record("completed"),
      id: `settled-${index}`,
      updatedAt: `2026-10-01T01:${String(10 + index).padStart(2, "0")}:00.000Z`,
    }));
    const oldQueued = { ...record("queued"), id: "old-queued", updatedAt: "2026-10-01T00:00:00.000Z" };
    client({ list: vi.fn(async () => [oldQueued, ...settled]) });
    dialog();
    expect(await screen.findByRole("button", { name: "Cancel queued handoff to Review Dashboard" })).toBeVisible();
    expect(document.querySelectorAll('[data-handoff-status="completed"]')).toHaveLength(8);
    expect(document.querySelectorAll('[data-handoff-status="queued"]')).toHaveLength(1);
  });

  it("names row actions by their handoff and hides Return findings once returned", async () => {
    const incoming = (id: string, sourceName: string): HandoffRecord => ({
      ...record("completed"),
      id,
      sourceThreadId: TARGET.id,
      targetThreadId: SOURCE.id,
      sourceName,
      targetName: SOURCE.name,
      result: "Findings",
    });
    const returned = incoming("returned", "Claude B");
    const returnRecord: HandoffRecord = {
      ...record("delivered"),
      id: "return",
      returnOfId: returned.id,
    };
    const interruptedReturn: HandoffRecord = {
      ...record("interrupted"),
      id: "return-interrupted",
      returnOfId: "retry",
    };
    client({
      list: vi.fn(async () => [
        returned,
        returnRecord,
        incoming("fresh", "Claude C"),
        incoming("retry", "Claude D"),
        interruptedReturn,
      ]),
    });
    dialog();
    expect(await screen.findByRole("button", { name: "Return findings to Claude C" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Return findings to Claude D" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Return findings to Claude B" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Open receiver Review Dashboard" })).toHaveLength(2);
  });

  it("holds Return findings while a send is in flight, so neither replaces the other", async () => {
    const incoming: HandoffRecord = {
      ...record("completed"),
      id: "incoming",
      sourceThreadId: TARGET.id,
      targetThreadId: SOURCE.id,
      sourceName: "Claude C",
      targetName: SOURCE.name,
      result: "Findings",
    };
    let finishSend: () => void = () => {};
    const send = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          finishSend = () => reject({ category: "internal", code: "x", message: "Send failed.", retryable: false });
        }),
    );
    const api = client({ list: vi.fn(async () => [incoming]), send });
    dialog();
    const user = userEvent.setup();
    const returnFindings = await screen.findByRole("button", { name: "Return findings to Claude C" });
    await user.click(screen.getByRole("button", { name: "Prepare handoff" }));
    await user.click(await screen.findByRole("button", { name: "Send handoff" }));

    expect(returnFindings).toBeDisabled();
    await user.click(returnFindings);
    expect(api.returnFindings).not.toHaveBeenCalled();

    await act(async () => finishSend());
    await waitFor(() => expect(screen.getByRole("button", { name: "Return findings to Claude C" })).toBeEnabled());
  });
});
