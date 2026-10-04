import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Integration, integrationClient } from "../../ipc/integrationClient.ts";
import { IntegrationHub } from "./IntegrationHub.tsx";

vi.mock("../../ipc/integrationClient.ts", async (original) => ({
  ...(await original<typeof import("../../ipc/integrationClient.ts")>()),
  integrationClient: {
    list: vi.fn(),
    save: vi.fn(),
    refresh: vi.fn(),
    disconnect: vi.fn(),
    rename: vi.fn(),
    grants: vi.fn(),
    configuration: vi.fn(),
  },
}));
const integration: Integration = {
  id: "github",
  name: "GitHub",
  kind: "remote_mcp",
  endpoint: "https://api.githubcopilot.com/mcp/",
  connected: true,
  health: "healthy",
  status_message: "Connection verified",
  revision: 1,
  last_checked_ms: 1_770_000_000_000,
  grants: [],
  capabilities: [
    { name: "get_issue", description: "Read an issue", risk: "read", input_schema: { type: "object", properties: {} } },
    {
      name: "create_issue",
      description: "Create an issue",
      risk: "sensitive",
      input_schema: { type: "object", properties: {} },
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(integrationClient.list).mockResolvedValue([]);
});

describe("Integration Hub", () => {
  it("starts empty without invented connected services", async () => {
    render(<IntegrationHub />);
    expect(await screen.findByText("Bring your tools closer.")).toBeTruthy();
    expect(screen.queryByText("Healthy")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect a tool" })).toBeTruthy();
  });
  it("grants only explicitly selected tools to the exact real session", async () => {
    vi.mocked(integrationClient.list).mockResolvedValue([integration]);
    const scope = { workspace_id: "workspace-a", surface: "code" as const, session_id: "real-agent-1" };
    render(<IntegrationHub scopes={[{ label: "App · Release agent", scope }]} />);
    fireEvent.click(await screen.findByRole("button", { name: /GitHub.*Remote MCP/ }));
    fireEvent.change(screen.getByLabelText("Workspace / agent or workflow"), { target: { value: "0" } });
    expect(screen.getByRole("checkbox", { name: /create_issue.*Approval required/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /get_issue.*Read/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() =>
      expect(integrationClient.grants).toHaveBeenCalledWith("github", [{ ...scope, tool_names: ["get_issue"] }]),
    );
  });
  it("reports real authentication expiry with reconnect", async () => {
    vi.mocked(integrationClient.list).mockResolvedValue([
      { ...integration, health: "auth_expired", status_message: "GitHub authentication expired. Reconnect." },
    ]);
    render(<IntegrationHub />);
    fireEvent.click(await screen.findByRole("button", { name: /GitHub.*Remote MCP/ }));
    expect(screen.getByText("GitHub authentication expired. Reconnect.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
  it("clears the credential input before native IPC and keeps errors actionable", async () => {
    vi.mocked(integrationClient.save).mockRejectedValue(
      new Error("OS credential store unavailable. Unlock your keychain and retry."),
    );
    render(<IntegrationHub />);
    await screen.findByText("Bring your tools closer.");
    fireEvent.click(screen.getByRole("button", { name: "Connect a tool" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Internal API" } });
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://api.example.com/mcp" } });
    const secret = screen.getByLabelText(/Access token/) as HTMLInputElement;
    fireEvent.change(secret, { target: { value: "test-credential" } });
    fireEvent.submit(screen.getByRole("form", { name: "Connect integration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unlock your keychain and retry");
    expect(secret.value).toBe("");
    expect(integrationClient.save).toHaveBeenCalledWith(
      expect.objectContaining({ trusted_read_tools: [] }),
      "test-credential",
    );
    expect(document.body.textContent).not.toContain("test-credential");
  });
  it("rejects invalid custom tool JSON without invoking native save", async () => {
    render(<IntegrationHub />);
    await screen.findByText("Bring your tools closer.");
    fireEvent.click(screen.getByRole("button", { name: "Connect a tool" }));
    fireEvent.change(screen.getByLabelText("Connection type"), { target: { value: "custom_api" } });
    fireEvent.change(screen.getByLabelText(/Tool definitions/), { target: { value: "{bad" } });
    fireEvent.submit(screen.getByRole("form", { name: "Connect integration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("valid JSON");
    expect(integrationClient.save).not.toHaveBeenCalled();
  });
});
