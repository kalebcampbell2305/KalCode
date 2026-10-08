import type { ThreadSummary } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentClaim, Ownership, OwnershipOverlap } from "../../../runtime/ownership/model.ts";
import { PaneOwnershipChip } from "./PaneParts.tsx";

const agent = (id: string, name: string) => ({ id, name, workspaceId: "ws" }) as unknown as ThreadSummary;
const ME = agent("me", "Checkout Work");
const BILLING = agent("billing", "Billing Fix");
const PRICING = agent("pricing", "Pricing Update");

const state = vi.hoisted(() => ({ ownership: null as unknown, focus: vi.fn() }));
vi.mock("../../dashboard/data/DashboardData.tsx", () => ({
  useOptionalOwnership: () => state.ownership,
}));
vi.mock("../../../runtime/uiIntents.tsx", () => ({ useOptionalUiIntents: () => ({ focus: state.focus }) }));

const overlap = (risk: OwnershipOverlap["risk"], other: string, files: string[]): OwnershipOverlap => ({
  key: `ownership:${other}`,
  agentIds: ["me", other],
  workspaceId: "ws",
  risk,
  files,
  incomplete: false,
  area: risk === "area" ? { owner: other, entrant: "me", pattern: "src/pricing/**" } : null,
  allowed: false,
});
const ownershipOf = (overlaps: OwnershipOverlap[], claim: Partial<AgentClaim> = {}): Ownership => ({
  claims: new Map([
    [
      "me",
      {
        agentId: "me",
        name: ME.name,
        workspaceId: "ws",
        files: [],
        received: null,
        handedTo: null,
        ...claim,
      } as AgentClaim,
    ],
    ...[BILLING, PRICING].map(
      (other) =>
        [
          other.id,
          { agentId: other.id, name: other.name, workspaceId: "ws", files: [] } as unknown as AgentClaim,
        ] as const,
    ),
  ]),
  overlaps,
  byAgent: overlaps.length
    ? new Map([["me", overlaps.map((o) => ({ other: o.agentIds[1] === "billing" ? BILLING : PRICING, overlap: o }))]])
    : new Map(),
});

const view = () =>
  render(
    <TooltipProvider>
      <PaneOwnershipChip thread={ME} />
    </TooltipProvider>,
  );

beforeEach(() => {
  state.ownership = null;
  state.focus.mockReset();
});

describe("PaneOwnershipChip", () => {
  it("renders nothing without overlaps or handoffs", () => {
    state.ownership = ownershipOf([]);
    expect(view().container).toBeEmptyDOMElement();
  });

  it("renders nothing outside the data boundary", () => {
    expect(view().container).toBeEmptyDOMElement();
  });

  it("is red and names the other agent for a conflict, with the files in its tooltip", async () => {
    state.ownership = ownershipOf([overlap("conflict", "billing", ["src/a.ts", "src/b.ts"])]);
    view();
    const chip = screen.getByRole("button", { name: /Overlaps Billing Fix/ });
    expect(chip).toHaveAttribute("data-tone", "danger");
    await userEvent.hover(chip);
    expect((await screen.findAllByText("src/a.ts")).length).toBeGreaterThan(0);
    await userEvent.click(chip);
    expect(state.focus).toHaveBeenCalledWith({ kind: "agent", agentId: "billing", workspaceId: "ws" });
  });

  it("is amber for an area overlap and counts the others", () => {
    state.ownership = ownershipOf([
      overlap("area", "pricing", ["src/pricing/x.ts"]),
      overlap("same-files", "billing", ["q"]),
    ]);
    view();
    const chip = screen.getByRole("button", { name: /Overlaps Pricing Update \+1/ });
    expect(chip).toHaveAttribute("data-tone", "waiting");
  });

  it("stays quiet for allowed or compatible overlaps", () => {
    state.ownership = ownershipOf([
      { ...overlap("same-files", "billing", ["a"]), allowed: true },
      overlap("compatible", "pricing", ["b"]),
    ]);
    expect(view().container).toBeEmptyDOMElement();
  });

  it("shows a quiet blue handoff chip", () => {
    state.ownership = ownershipOf([], { received: { from: "billing", handoffId: "h", files: ["a.ts"] } });
    view();
    expect(screen.getByRole("button", { name: /From Billing Fix/ })).toHaveAttribute("data-tone", "info");
  });

  it("shows who the agent handed work to", () => {
    state.ownership = ownershipOf([], { handedTo: { to: "pricing", handoffId: "h" } });
    view();
    expect(screen.getByRole("button", { name: /Handed to Pricing Update/ })).toBeInTheDocument();
  });
});
