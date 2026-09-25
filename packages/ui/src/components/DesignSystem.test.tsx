import { DISPLAY_STATUS_LABEL, DISPLAY_STATUS_TONE, type DisplayStatus } from "@kalcode/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { Badge } from "./Badge.tsx";
import { Panel } from "./Panel.tsx";
import { ProviderMark, providerIdentity } from "./ProviderMark.tsx";
import { Sparkline, Stat, StatGroup } from "./Stat.tsx";
import { EmptyState, ErrorState } from "./States.tsx";
import { DISPLAY_STATUS_GLYPH, DISPLAY_STATUS_TEXT, StatusChip } from "./StatusChip.tsx";
import { StatusIndicator } from "./StatusIndicator.tsx";
import { RowItem, RowList, Table } from "./Table.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs.tsx";

const STATUSES = Object.keys(DISPLAY_STATUS_TONE) as DisplayStatus[];

async function expectNoAxeViolations(container: HTMLElement) {
  const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  expect(result.violations.map((v) => v.id)).toEqual([]);
}

describe("StatusChip", () => {
  it("covers every display status with words, a glyph and the contract tone", () => {
    for (const status of STATUSES) {
      expect(DISPLAY_STATUS_TEXT[status].toUpperCase()).toBe(DISPLAY_STATUS_LABEL[status]);
      expect(DISPLAY_STATUS_GLYPH[status]).toBeTruthy();
    }
  });

  it("derives tone, words and glyph from a display status", () => {
    const { container } = render(<StatusChip status="permission_required" />);
    const chip = container.firstElementChild as HTMLElement;
    expect(chip).toHaveAttribute("data-tone", "waiting");
    expect(chip).toHaveTextContent("Permission required");
    expect(chip.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("maps the owner's palette: paused is the only amber tone, waiting is neutral", () => {
    expect(DISPLAY_STATUS_TONE.paused).toBe("paused");
    expect(DISPLAY_STATUS_TONE.waiting_for_you).toBe("waiting");
    expect(DISPLAY_STATUS_TONE.working).toBe("working");
    expect(DISPLAY_STATUS_TONE.recovering).toBe("recovering");
  });

  it("shows a contract qualifier in words", () => {
    render(<StatusChip status="idle" qualifier="stopped_resumable" />);
    expect(screen.getByText("stopped · resumable")).toBeInTheDocument();
  });

  it("accepts a label and tone without a status, with a dot variant", () => {
    const { container } = render(<StatusChip tone="done" label="Completed" variant="dot" />);
    expect(container.firstElementChild).toHaveAttribute("data-tone", "done");
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("marks a status change for the one-shot highlight", () => {
    const { container, rerender } = render(<StatusChip status="working" />);
    expect(container.firstElementChild).not.toHaveAttribute("data-changed");
    rerender(<StatusChip status="done" />);
    expect(container.firstElementChild).toHaveAttribute("data-changed");
    expect(container.firstElementChild).toHaveAttribute("data-tone", "done");
  });
});

describe("StatusIndicator", () => {
  it("keeps legacy tones and accepts contract tones", () => {
    const { rerender, container } = render(<StatusIndicator tone="success">Healthy</StatusIndicator>);
    expect(container.firstElementChild).toHaveAttribute("data-tone", "success");
    rerender(<StatusIndicator tone="paused">Paused</StatusIndicator>);
    expect(container.firstElementChild).toHaveAttribute("data-tone", "paused");
  });
});

describe("ProviderMark", () => {
  it("names known providers in plain text next to a KalCode glyph", () => {
    const { container } = render(<ProviderMark provider="claude-code" />);
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("data-glyph", "claude");
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("gives each known provider a distinct glyph and unknown ones a lettered hexagon", () => {
    const glyphs = ["claude-code", "codex", "gemini-cli", "shell"].map((id) => providerIdentity(id).glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    const { container } = render(<ProviderMark provider="future-cli" name="Future CLI" />);
    expect(container.querySelector("svg")).toHaveAttribute("data-glyph", "generic");
    expect(container.querySelector("svg text")).toHaveTextContent("F");
  });

  it("keeps the name for assistive tech when it is visually hidden", () => {
    render(<ProviderMark provider="codex" hideName detail="gpt-5" />);
    expect(screen.getByText("Codex")).toHaveClass("visually-hidden");
    expect(screen.getByText("gpt-5")).toBeInTheDocument();
  });
});

describe("Panel, Stat, Table, Tabs, states", () => {
  it("labels a panel region by its title and shows the count", async () => {
    const { container } = render(
      <Panel
        id="approvals"
        title="Needs approval"
        count={2}
        countTone="attention"
        actions={<button type="button">View all</button>}
      >
        <p>Body</p>
      </Panel>,
    );
    expect(screen.getByRole("region", { name: /^Needs approval/ })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("renders a KPI strip; a selectable stat is a toggle button", async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <StatGroup>
        <Stat label="Working now" value={5} tone="working" trend={<Sparkline values={[1, 3, 2, 5]} />} />
        <Stat label="Waiting for you" value={2} tone="waiting" onSelect={onSelect} selected />
      </StatGroup>,
    );
    expect(screen.getByText("Working now")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /Waiting for you/ });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    await expectNoAxeViolations(container);
  });

  it("renders a named table and a named row list", async () => {
    const { container } = render(
      <>
        <Table caption="Rules" captionHidden framed>
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">Decision</th>
            </tr>
          </thead>
          <tbody>
            <tr data-selected>
              <td>Run commands</td>
              <td>
                <Badge tone="waiting">Ask</Badge>
              </td>
            </tr>
          </tbody>
        </Table>
        <RowList label="Terminals">
          <RowItem selected>PowerShell 7</RowItem>
        </RowList>
      </>,
    );
    expect(screen.getByRole("table", { name: "Rules" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Terminals" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("switches tabs with the keyboard", async () => {
    render(
      <Tabs defaultValue="chat">
        <TabsList aria-label="Pane">
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="chat">Chat body</TabsContent>
        <TabsContent value="files">Files body</TabsContent>
      </Tabs>,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Chat" }));
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Files body")).toBeVisible();
  });

  it("frames empty states by default and error states as alerts", () => {
    const { container } = render(
      <>
        <EmptyState title="No threads yet" art={<svg />}>
          <p>Start one.</p>
        </EmptyState>
        <ErrorState title="Couldn't load" code="E_IO" />
      </>,
    );
    expect(container.querySelector('[data-align="start"]')?.className).toMatch(/framed/);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load");
    expect(screen.getByText("Error code: E_IO")).toBeInTheDocument();
  });
});
