import "../../src/styles/fonts.css";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import { createRoot } from "react-dom/client";
import type { DiffFileData, DiffLine, DiffMode } from "../../src/components/DiffView.model.ts";
import { DiffView } from "../../src/components/DiffView.tsx";

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
const mode: DiffMode = params.get("mode") === "split" ? "split" : "unified";

const line = (kind: DiffLine["kind"], oldLine: number | null, newLine: number | null, text: string): DiffLine => ({
  kind,
  oldLine,
  newLine,
  text,
});

const big = 3000;
const files: DiffFileData[] = [
  {
    path: "crates/git/src/status.rs",
    change: "modified",
    additions: 3,
    deletions: 2,
    binary: false,
    hunks: [
      {
        header: "@@ -10,7 +10,8 @@ pub fn status(git: &Git, repo: &Repo) -> Result<Status> {",
        oldStart: 10,
        oldLines: 7,
        newStart: 10,
        newLines: 8,
        lines: [
          line("context", 10, 10, "    let mut cmd = repo.cmd(git).args(["),
          line("context", 11, 11, '        "status",'),
          line("delete", 12, null, '        "--porcelain",'),
          line("delete", 13, null, '        "--branch",'),
          line("add", null, 12, '        "--porcelain=v2",'),
          line("add", null, 13, '        "-z",'),
          line("add", null, 14, '        "--branch",'),
          line("context", 14, 15, "    ]);"),
          line("context", 15, 16, '\tlet out = cmd.read_only().run_ok("status")?;'),
          line("context", 16, 17, "    Ok(parse_porcelain_v2(&out.stdout))"),
          line("no_newline", null, null, ""),
        ],
      },
    ],
  },
  {
    path: "docs/renamed-guide.md",
    oldPath: "docs/guide.md",
    change: "renamed",
    additions: 0,
    deletions: 0,
    binary: false,
    hunks: [],
  },
  { path: "assets/logo.png", change: "added", additions: 0, deletions: 0, binary: true, hunks: [] },
  {
    path: "generated/large.txt",
    change: "added",
    additions: big,
    deletions: 0,
    binary: false,
    hunksTruncated: true,
    hunks: [
      {
        header: `@@ -0,0 +1,${big} @@`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: big,
        lines: Array.from({ length: big }, (_, i) => line("add", null, i + 1, `generated line ${i + 1}`)),
      },
    ],
  },
  {
    path: "old/removed.rs",
    change: "deleted",
    additions: 0,
    deletions: 1,
    binary: false,
    hunks: [
      {
        header: "@@ -1 +0,0 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 0,
        newLines: 0,
        lines: [line("delete", 1, null, "fn gone() {}")],
      },
    ],
  },
];

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <main style={{ padding: "var(--space-6)", background: "var(--color-bg)", minHeight: "100vh" }}>
      <h1 style={{ fontSize: "var(--text-lg)", marginTop: 0, color: "var(--color-text)" }}>DiffView harness</h1>
      <DiffView files={files} label="Harness changes" defaultMode={mode} height={520} truncated />
    </main>,
  );
}
