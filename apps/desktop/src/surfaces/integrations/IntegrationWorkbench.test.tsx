import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { integrationDispatch, type ToolScope } from "../../ipc/integrationClient.ts";
import { IntegrationHub } from "./IntegrationHub.tsx";
import { IntegrationWorkbench } from "./IntegrationWorkbench.tsx";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));

vi.mock("../../ipc/integrationClient.ts", async (original) => ({
  ...(await original<typeof import("../../ipc/integrationClient.ts")>()),
  integrationDispatch: vi.fn(),
}));
const scope: ToolScope = { workspace_id: "workspace", surface: "code", session_id: "release-agent" };
beforeEach(() => vi.clearAllMocks());

describe("connected tool workbench", () => {
  it("waits for explicit approval and resumes the exact pending turn", async () => {
    vi.mocked(integrationDispatch).mockImplementation(async (op) => {
      if (op === "openai_status") return { configured: true, model: "gpt-test" };
      if (op === "query")
        return {
          status: "approval_required",
          turn_id: "turn-1",
          approval: {
            id: "approval-1",
            integration_name: "Deployments",
            tool_name: "deploy_preview",
            arguments_preview: { branch: "preview" },
            expires_at_ms: Date.now() + 60_000,
          },
        };
      if (op === "resume") return { status: "completed", text: "Preview is deployed.", tool_calls: 1 };
      return null;
    });
    render(<IntegrationWorkbench scope={scope} />);
    await screen.findByText("OpenAI · gpt-test · API key saved");
    fireEvent.change(screen.getByLabelText("Request"), { target: { value: "Deploy preview" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask tools" }));
    await screen.findByText("Review external action");
    expect(integrationDispatch).not.toHaveBeenCalledWith("approve", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
    expect(await screen.findByText("Preview is deployed.")).toBeTruthy();
    expect(integrationDispatch).toHaveBeenCalledWith("approve", { approval_id: "approval-1" });
    expect(integrationDispatch).toHaveBeenCalledWith("resume", { scope, turn_id: "turn-1" });
  });
  it("never displays a previous workspace's late external result after changing scope", async () => {
    let resolve: (value: unknown) => void = () => {};
    vi.mocked(integrationDispatch).mockImplementation((op) =>
      op === "openai_status"
        ? Promise.resolve({ configured: true, model: "gpt-test" })
        : new Promise((done) => {
            resolve = done;
          }),
    );
    const view = render(<IntegrationWorkbench scope={scope} />);
    await screen.findByText("OpenAI · gpt-test · API key saved");
    fireEvent.change(screen.getByLabelText("Request"), { target: { value: "Check production" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask tools" }));
    await waitFor(() =>
      expect(integrationDispatch).toHaveBeenCalledWith("query", { scope, prompt: "Check production" }),
    );
    view.rerender(<IntegrationWorkbench scope={{ ...scope, workspace_id: "another-workspace" }} />);
    await act(async () => resolve({ status: "completed", text: "Private production result", tool_calls: 1 }));
    expect(screen.queryByText("Private production result")).toBeNull();
  });
  it("resumes an action approved in the Hub inbox without requesting approval twice", async () => {
    const actual = await vi.importActual<typeof import("../../ipc/integrationClient.ts")>(
      "../../ipc/integrationClient.ts",
    );
    vi.mocked(integrationDispatch).mockImplementation(actual.integrationDispatch);
    const approval = {
      id: "approval-inbox",
      integration_id: "deploy",
      integration_name: "Deployments",
      tool_name: "deploy_preview",
      scope,
      arguments_preview: { branch: "preview" },
      expires_at_ms: Date.now() + 60_000,
    };
    let approved = false;
    vi.mocked(invoke).mockImplementation(async (_command, raw) => {
      const { request } = raw as { request: { op: string; approval_id?: string } };
      if (request.op === "list") return [];
      if (request.op === "pending") return approved ? [] : [approval];
      if (request.op === "openai_status") return { configured: true, model: "gpt-test" };
      if (request.op === "query") return { status: "approval_required", turn_id: "turn-inbox", approval };
      if (request.op === "approve") {
        if (approved) throw new Error("This approval expired. Request the action again.");
        approved = true;
        return null;
      }
      if (request.op === "resume") {
        if (!approved) throw new Error("Approval is required.");
        return { status: "completed", text: "Inbox-approved preview deployed.", tool_calls: 1 };
      }
      throw new Error("Unexpected integration operation");
    });
    render(
      <>
        <IntegrationHub />
        <IntegrationWorkbench scope={scope} />
      </>,
    );
    await screen.findByText("OpenAI · gpt-test · API key saved");
    expect(screen.queryByText(/gpt-test.*Connected/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Request"), { target: { value: "Deploy preview" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask tools" }));
    await screen.findByText("Review external action");
    fireEvent.click(screen.getByRole("button", { name: "Review and approve once" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue approved action" }));
    expect(await screen.findByText("Inbox-approved preview deployed.")).toBeTruthy();
    const operations = vi.mocked(invoke).mock.calls.map(([, args]) => (args as { request: { op: string } }).request.op);
    expect(operations.filter((op) => op === "approve")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("integration_dispatch", {
      request: { op: "resume", scope, turn_id: "turn-inbox" },
    });
  });
});
