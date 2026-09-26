/**
 * DiffView data model: the shapes native diff commands return (`git_diff`, `checkpoint_diff`;
 * camelCase JSON of `kalcode_git::diff::Diff`) and the flattening into fixed-height rows that the
 * virtualized view renders. Pure functions, no React.
 */

export type DiffLineKind = "context" | "add" | "delete" | "no_newline";

export interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@ section` line. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffChange = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed" | "unmerged";

export interface DiffFileData {
  /** Workspace-relative display path. */
  path: string;
  oldPath?: string | null;
  change: DiffChange;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
  /** Some hunks or lines were left out by a size cap. */
  hunksTruncated?: boolean;
}

export type DiffMode = "unified" | "split";

export type DiffNotice = "binary" | "truncated" | "no_content" | "content_unavailable";

export type DiffRow =
  | { type: "file"; key: string; fileIndex: number; file: DiffFileData }
  | { type: "hunk"; key: string; fileIndex: number; header: string }
  | { type: "line"; key: string; fileIndex: number; line: DiffLine }
  | { type: "pair"; key: string; fileIndex: number; left: DiffLine | null; right: DiffLine | null }
  | { type: "notice"; key: string; fileIndex: number; notice: DiffNotice };

export interface LinePair {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * Side-by-side pairing: a run of deletions followed by a run of additions is shown row by row
 * (old on the left, new on the right); context lines appear on both sides. A "no newline" marker
 * stays on the side of the line it belongs to.
 */
export function pairLines(lines: readonly DiffLine[]): LinePair[] {
  const pairs: LinePair[] = [];
  let deletes: DiffLine[] = [];
  let adds: DiffLine[] = [];
  let lastSide: "left" | "right" | "both" = "both";
  const flush = () => {
    const count = Math.max(deletes.length, adds.length);
    for (let i = 0; i < count; i += 1) {
      pairs.push({ left: deletes[i] ?? null, right: adds[i] ?? null });
    }
    deletes = [];
    adds = [];
  };
  for (const line of lines) {
    switch (line.kind) {
      case "delete":
        if (adds.length > 0) flush();
        deletes.push(line);
        lastSide = "left";
        break;
      case "add":
        adds.push(line);
        lastSide = "right";
        break;
      case "no_newline":
        if (lastSide === "left") deletes.push(line);
        else if (lastSide === "right") adds.push(line);
        else {
          flush();
          pairs.push({ left: line, right: line });
        }
        break;
      default:
        flush();
        pairs.push({ left: line, right: line });
        lastSide = "both";
    }
  }
  flush();
  return pairs;
}

/** Flattens files into rows: a header per file, a header per hunk, then its lines. */
export function buildRows(files: readonly DiffFileData[], mode: DiffMode): DiffRow[] {
  const rows: DiffRow[] = [];
  files.forEach((file, fileIndex) => {
    const base = `${fileIndex}:${file.path}`;
    rows.push({ type: "file", key: `${base}:f`, fileIndex, file });
    if (file.binary) {
      rows.push({ type: "notice", key: `${base}:bin`, fileIndex, notice: "binary" });
      return;
    }
    if (file.hunks.length === 0 && !file.hunksTruncated) {
      rows.push({
        type: "notice",
        key: `${base}:none`,
        fileIndex,
        notice: file.additions > 0 || file.deletions > 0 ? "content_unavailable" : "no_content",
      });
    }
    file.hunks.forEach((hunk, hunkIndex) => {
      rows.push({ type: "hunk", key: `${base}:h${hunkIndex}`, fileIndex, header: hunk.header });
      if (mode === "unified") {
        hunk.lines.forEach((line, lineIndex) => {
          rows.push({ type: "line", key: `${base}:h${hunkIndex}:${lineIndex}`, fileIndex, line });
        });
      } else {
        pairLines(hunk.lines).forEach((pair, pairIndex) => {
          rows.push({ type: "pair", key: `${base}:h${hunkIndex}:p${pairIndex}`, fileIndex, ...pair });
        });
      }
    });
    if (file.hunksTruncated) {
      rows.push({ type: "notice", key: `${base}:cut`, fileIndex, notice: "truncated" });
    }
  });
  return rows;
}

/** Index of the next (direction 1) or previous (-1) file or hunk header from `from`. */
export function nextSection(rows: readonly DiffRow[], from: number, direction: 1 | -1): number {
  for (let i = from + direction; i >= 0 && i < rows.length; i += direction) {
    const row = rows[i];
    if (row && (row.type === "hunk" || row.type === "file")) return i;
  }
  return from;
}

export const CHANGE_LABEL: Record<DiffChange, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  type_changed: "Type changed",
  unmerged: "Conflict",
};
