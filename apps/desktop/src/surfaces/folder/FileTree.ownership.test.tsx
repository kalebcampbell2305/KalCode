import type { FileEntry, Page } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentClaim } from "../../runtime/ownership/model.ts";
import { FileTree } from "./FileTree.tsx";

vi.mock("../../shell/context/ContentContextMenu.tsx", () => ({
  ContentContextMenu: ({ children }: { children: React.ReactNode }) => children,
}));
const runtime = vi.hoisted(() => ({ client: { listFiles: vi.fn() } }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime }));
const state = vi.hoisted(() => ({ ownership: null as unknown }));
vi.mock("../dashboard/data/DashboardData.tsx", () => ({
  useOptionalOwnership: () => state.ownership,
}));
const NAMES: Record<string, { name: string; providerName: string }> = {
  a1: { name: "Billing Fix", providerName: "Claude" },
  a2: { name: "Pricing Update", providerName: "Codex" },
  a3: { name: "Docs", providerName: "Claude" },
};

const entry = (displayPath: string, isDir = false): FileEntry => ({
  file: { displayPath, workspaceId: "ws", handle: { id: displayPath } } as FileEntry["file"],
  isDir,
  bytes: isDir ? null : 10,
  ignored: false,
});
const page = (...items: FileEntry[]): Page<FileEntry> => ({ items, nextCursor: null, totalEstimate: items.length });
const claim = (agentId: string, extra: Partial<AgentClaim>): AgentClaim =>
  ({
    agentId,
    ...NAMES[agentId],
    active: true,
    worktreeId: null,
    workspaceId: "ws",
    files: [],
    areas: [],
    received: null,
    handedTo: null,
    ...extra,
  }) as AgentClaim;
const ownershipOf = (...claims: AgentClaim[]) => ({
  claims: new Map(claims.map((c) => [c.agentId, c])),
  overlaps: [],
  byAgent: new Map(),
});

const view = () =>
  render(
    <TooltipProvider>
      <FileTree workspaceId="ws" />
    </TooltipProvider>,
  );

beforeEach(() => {
  state.ownership = null;
  runtime.client = {
    listFiles: vi.fn(async () => page(entry("src", true), entry("README.md"))),
  };
});

describe("file ownership markers", () => {
  it("adds nothing when nobody holds files", async () => {
    state.ownership = ownershipOf(claim("a1", {}));
    const { container } = view();
    await screen.findByRole("treeitem", { name: "README.md" });
    expect(container.querySelector("[data-owner-marker]")).toBeNull();
  });

  it("marks a held file, says so in its name and in the tooltip", async () => {
    state.ownership = ownershipOf(claim("a1", { files: ["README.md"] }));
    view();
    const row = await screen.findByRole("treeitem", { name: /README\.md, Claude · Billing Fix is editing this file/ });
    const marker = row.querySelector("[data-owner-marker]") as HTMLElement;
    expect(marker).toHaveAttribute("data-tone", "working");
    await userEvent.hover(marker);
    expect((await screen.findAllByText("Claude · Billing Fix is editing this file")).length).toBeGreaterThan(0);
  });

  it("says where and when: a worktree copy, or unmerged changes of an ended agent", async () => {
    state.ownership = ownershipOf(claim("a1", { files: ["README.md"], worktreeId: "wt-1" }));
    const first = view();
    await screen.findByRole("treeitem", { name: /Billing Fix is changing this file in its own worktree/ });
    first.unmount();
    state.ownership = ownershipOf(claim("a1", { files: ["README.md"], worktreeId: "wt-1", active: false }));
    view();
    await screen.findByRole("treeitem", { name: /Billing Fix has unmerged changes to this file/ });
  });

  it("uses the area wording and an amber dot when two agents edit one file", async () => {
    state.ownership = ownershipOf(
      claim("a2", { areas: ["README.md"] }),
      claim("a1", { files: ["README.md"] }),
      claim("a3", { files: ["README.md"] }),
    );
    view();
    const row = await screen.findByRole("treeitem", { name: /README\.md/ });
    expect(row.querySelector("[data-owner-marker]")).toHaveAttribute("data-tone", "shared");
    expect(row).toHaveAccessibleName(/In Pricing Update's area/);
  });

  it("marks a received file blue and a folder holding a file", async () => {
    state.ownership = ownershipOf(
      claim("a2", { received: { from: "a1", handoffId: "h", files: ["README.md"] } }),
      claim("a1", { files: ["src/a.ts"] }),
    );
    view();
    const readme = await screen.findByRole("treeitem", { name: /README\.md/ });
    expect(readme.querySelector("[data-owner-marker]")).toHaveAttribute("data-tone", "received");
    const dir = screen.getByRole("treeitem", { name: /^src, folder, Claude · Billing Fix has files in this folder/ });
    expect(dir.querySelector("[data-owner-marker]")).toBeInTheDocument();
  });
});
