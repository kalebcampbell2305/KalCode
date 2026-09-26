import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { buildRows, type DiffFileData, type DiffLine, pairLines } from "./DiffView.model.ts";
import { DiffView } from "./DiffView.tsx";

const line = (kind: DiffLine["kind"], oldLine: number | null, newLine: number | null, text: string): DiffLine => ({
  kind,
  oldLine,
  newLine,
  text,
});

const small: DiffFileData[] = [
  {
    path: "src/lib.rs",
    change: "modified",
    additions: 2,
    deletions: 1,
    binary: false,
    hunks: [
      {
        header: "@@ -1,3 +1,4 @@ fn main",
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        lines: [
          line("context", 1, 1, "one"),
          line("delete", 2, null, "two"),
          line("add", null, 2, "TWO"),
          line("add", null, 3, "two and a half"),
          line("context", 3, 4, "three"),
        ],
      },
    ],
  },
  { path: "logo.png", change: "added", additions: 0, deletions: 0, binary: true, hunks: [] },
  {
    path: "new-name.txt",
    oldPath: "old-name.txt",
    change: "renamed",
    additions: 0,
    deletions: 0,
    binary: false,
    hunks: [],
  },
];

function bigDiff(lines: number): DiffFileData[] {
  return [
    {
      path: "huge.txt",
      change: "modified",
      additions: lines,
      deletions: 0,
      binary: false,
      hunks: [
        {
          header: `@@ -0,0 +1,${lines} @@`,
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: lines,
          lines: Array.from({ length: lines }, (_, i) => line("add", null, i + 1, `line ${i + 1}`)),
        },
      ],
    },
  ];
}

describe("DiffView model", () => {
  it("pairs deletions with additions and keeps context on both sides", () => {
    const pairs = pairLines(small[0]?.hunks[0]?.lines ?? []);
    expect(pairs.map((p) => [p.left?.text ?? null, p.right?.text ?? null])).toEqual([
      ["one", "one"],
      ["two", "TWO"],
      [null, "two and a half"],
      ["three", "three"],
    ]);
  });

  it("keeps a no-newline marker on its own side", () => {
    const pairs = pairLines([
      line("delete", 1, null, "a"),
      line("no_newline", null, null, ""),
      line("add", null, 1, "b"),
      line("no_newline", null, null, ""),
    ]);
    expect(pairs).toHaveLength(2);
    expect(pairs[1]?.left?.kind).toBe("no_newline");
    expect(pairs[1]?.right?.kind).toBe("no_newline");
  });

  it("flattens files, hunks and notices", () => {
    const rows = buildRows(small, "unified");
    expect(rows.map((r) => r.type)).toEqual([
      "file",
      "hunk",
      "line",
      "line",
      "line",
      "line",
      "line",
      "file",
      "notice",
      "file",
      "notice",
    ]);
  });
});

describe("DiffView", () => {
  it("renders a unified diff with markers that aren't colour-only", () => {
    render(<DiffView files={small} label="Workspace changes" />);
    const grid = screen.getByRole("grid", { name: "Workspace changes" });
    expect(grid).toHaveAttribute("aria-rowcount", "11");
    expect(grid).toHaveAttribute("aria-colcount", "3");
    const removed = within(grid).getByText("two", { exact: true }).closest("td");
    expect(removed).toHaveTextContent("Removed: two");
    expect(within(grid).getByText("Binary file — contents not shown.")).toBeInTheDocument();
    expect(within(grid).getByText("old-name.txt → new-name.txt")).toBeInTheDocument();
    expect(screen.getByText("3 files")).toBeInTheDocument();
  });

  it("switches to split layout", async () => {
    const onModeChange = vi.fn();
    render(<DiffView files={small} label="Changes" onModeChange={onModeChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Split" }));
    expect(onModeChange).toHaveBeenCalledWith("split");
    const grid = screen.getByRole("grid", { name: "Changes" });
    expect(grid).toHaveAttribute("aria-colcount", "4");
    // "two" and "TWO" now share a row.
    const row = within(grid).getByText("TWO", { exact: true }).closest("tr");
    expect(row).toHaveTextContent("Removed: two");
  });

  it("renders only a window of rows for very large diffs", () => {
    render(<DiffView files={bigDiff(20_000)} label="Huge" height={400} rowHeight={20} />);
    const grid = screen.getByRole("grid", { name: "Huge" });
    expect(grid).toHaveAttribute("aria-rowcount", "20002");
    const rendered = grid.querySelectorAll("tr").length;
    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(120);
  });

  it.each(["unified", "split"] as const)("keeps %s rows bounded when scrolling away from the active row", (mode) => {
    const onFileActivate = vi.fn();
    const files = bigDiff(2_000);
    render(
      <DiffView
        files={files}
        label="Scrolling"
        mode={mode}
        height={400}
        rowHeight={20}
        onFileActivate={onFileActivate}
      />,
    );
    const grid = screen.getByRole("grid", { name: "Scrolling" });
    const viewport = grid.parentElement as HTMLElement;
    const initialActive = grid.getAttribute("aria-activedescendant") ?? "";

    fireEvent.scroll(viewport, { target: { scrollTop: 30_000 } });
    expect(grid.querySelectorAll("tr").length).toBeLessThan(80);
    expect(within(grid).getByText("line 1500", { exact: true })).toBeInTheDocument();
    expect(grid.getAttribute("aria-activedescendant")).toBe(initialActive);
    expect(document.getElementById(initialActive)).toHaveTextContent("huge.txt");
    expect(grid.querySelectorAll('[aria-rowindex="1"]')).toHaveLength(1);
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onFileActivate).toHaveBeenCalledWith(files[0], 0);

    fireEvent.keyDown(grid, { key: "End" });
    const lastActive = grid.getAttribute("aria-activedescendant") ?? "";
    fireEvent.scroll(viewport, { target: { scrollTop: 0 } });
    expect(grid.querySelectorAll("tr").length).toBeLessThan(80);
    expect(within(grid).getByText("line 1", { exact: true })).toBeInTheDocument();
    expect(grid.getAttribute("aria-activedescendant")).toBe(lastActive);
    expect(document.getElementById(lastActive)).toHaveTextContent("line 2000");
    expect(grid.querySelectorAll('[aria-rowindex="2002"]')).toHaveLength(1);

    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(document.getElementById(grid.getAttribute("aria-activedescendant") ?? "")).toHaveTextContent("line 1999");
    expect(viewport.scrollTop).toBeGreaterThan(30_000);
    expect(grid.querySelectorAll("tr").length).toBeLessThan(80);
  });

  it("keeps the active row valid when a scrolled diff is replaced with fewer rows", () => {
    const { rerender } = render(<DiffView files={bigDiff(2_000)} label="Replacing" height={400} rowHeight={20} />);
    const grid = screen.getByRole("grid", { name: "Replacing" });
    fireEvent.keyDown(grid, { key: "End" });
    fireEvent.scroll(grid.parentElement as HTMLElement, { target: { scrollTop: 30_000 } });

    rerender(<DiffView files={small} label="Replacing" height={400} rowHeight={20} />);
    expect(grid).toHaveAttribute("aria-rowcount", "11");
    expect(document.getElementById(grid.getAttribute("aria-activedescendant") ?? "")).toHaveTextContent(
      "No line changes",
    );
    expect(grid.querySelectorAll("tr").length).toBeLessThanOrEqual(11);
    fireEvent.keyDown(grid, { key: "Home" });
    expect(document.getElementById(grid.getAttribute("aria-activedescendant") ?? "")).toHaveTextContent("src/lib.rs");
    expect(grid.parentElement?.scrollTop).toBe(0);
  });

  it("is keyboard navigable", () => {
    const onFileActivate = vi.fn();
    render(<DiffView files={small} label="Keys" onFileActivate={onFileActivate} />);
    const grid = screen.getByRole("grid", { name: "Keys" });
    const activeText = () => {
      const id = grid.getAttribute("aria-activedescendant") ?? "";
      return document.getElementById(id)?.textContent ?? "";
    };
    grid.focus();
    expect(activeText()).toContain("src/lib.rs");
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onFileActivate).toHaveBeenCalledWith(small[0], 0);
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(activeText()).toContain("@@ -1,3 +1,4 @@");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(activeText()).toContain("one");
    fireEvent.keyDown(grid, { key: "n" });
    expect(activeText()).toContain("logo.png");
    fireEvent.keyDown(grid, { key: "p" });
    expect(activeText()).toContain("@@ -1,3 +1,4 @@");
    fireEvent.keyDown(grid, { key: "End" });
    expect(activeText()).toContain("No line changes");
    fireEvent.keyDown(grid, { key: "Home" });
    expect(activeText()).toContain("src/lib.rs");
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(activeText()).toContain("src/lib.rs");
  });

  it("keeps the active row rendered while paging through a large diff", () => {
    render(<DiffView files={bigDiff(5_000)} label="Paging" height={200} rowHeight={20} />);
    const grid = screen.getByRole("grid", { name: "Paging" });
    for (let i = 0; i < 30; i += 1) fireEvent.keyDown(grid, { key: "PageDown" });
    const id = grid.getAttribute("aria-activedescendant") ?? "";
    expect(document.getElementById(id)).not.toBeNull();
    fireEvent.keyDown(grid, { key: "End" });
    const last = document.getElementById(grid.getAttribute("aria-activedescendant") ?? "");
    expect(last).toHaveTextContent("line 5000");
  });

  it("renders line text as text, never as markup", () => {
    const hostile: DiffFileData[] = [
      {
        path: "x.html",
        change: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
        hunks: [
          {
            header: "@@ -0,0 +1 @@",
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [line("add", null, 1, '<img src=x onerror="alert(1)">')],
          },
        ],
      },
    ];
    const { container } = render(<DiffView files={hostile} label="Hostile" />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
  });

  it("shows empty and truncated states", () => {
    const { rerender } = render(<DiffView files={[]} label="Nothing" />);
    expect(screen.getByText("No changes.")).toBeInTheDocument();
    rerender(<DiffView files={small} label="Cut" truncated />);
    expect(screen.getByRole("status")).toHaveTextContent("size limit");
  });

  it("has no axe violations (structure; contrast is checked in the browser test)", async () => {
    for (const mode of ["unified", "split"] as const) {
      const { container, unmount } = render(
        <main>
          <DiffView files={small} label={`Changes ${mode}`} mode={mode} />
        </main>,
      );
      const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
      expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
      unmount();
    }
  });
});
