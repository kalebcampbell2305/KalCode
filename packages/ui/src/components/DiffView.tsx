import { type KeyboardEvent, type UIEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { cx } from "./cx.ts";
import {
  buildRows,
  CHANGE_LABEL,
  type DiffFileData,
  type DiffLine,
  type DiffMode,
  type DiffNotice,
  type DiffRow,
  nextSection,
} from "./DiffView.model.ts";
import styles from "./DiffView.module.css";
import { SegmentedControl } from "./SegmentedControl.tsx";

export interface DiffViewProps {
  files: readonly DiffFileData[];
  /** Accessible name of the diff grid ("Changes since checkpoint 3"). */
  label: string;
  /** Controlled display mode; omit to let the view manage it. */
  mode?: DiffMode;
  defaultMode?: DiffMode;
  onModeChange?: (mode: DiffMode) => void;
  /** The whole diff hit its size cap (files after the cut have no lines). */
  truncated?: boolean;
  /** Viewport height (CSS length or px). Rows outside it are not rendered. */
  height?: number | string;
  /** Fixed row height in px (virtualization relies on it). */
  rowHeight?: number;
  /** Enter (or a click) on a file header. */
  onFileActivate?: (file: DiffFileData, index: number) => void;
  /** Show the summary and mode toolbar (default true). */
  toolbar?: boolean;
  className?: string;
}

const OVERSCAN = 12;
const FALLBACK_VIEWPORT = 480;

const MODES = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
] as const;

const NOTICE_TEXT: Record<DiffNotice, string> = {
  binary: "Binary file — contents not shown.",
  truncated: "This file's diff was cut at its size limit; later lines aren't shown.",
  no_content: "No line changes (mode, rename or empty file).",
};

const KIND_LABEL: Record<DiffLine["kind"], string> = {
  add: "Added",
  delete: "Removed",
  context: "Unchanged",
  no_newline: "Note",
};

const MARKER: Record<DiffLine["kind"], string> = { add: "+", delete: "−", context: " ", no_newline: "\\" };

/**
 * Presentational diff viewer: unified or side-by-side, virtualized (only visible rows are in the
 * DOM, so 100k-line diffs stay fast), keyboard navigable as an ARIA grid with an active row:
 * ↑/↓ line, PageUp/PageDown page, Home/End ends, `n`/`p` next/previous hunk or file, Enter
 * activates a file header. Changes are marked with +/− and a hidden text label, never by colour
 * alone. Line text is rendered as text (never as HTML).
 */
export function DiffView({
  files,
  label,
  mode: controlledMode,
  defaultMode = "unified",
  onModeChange,
  truncated = false,
  height = FALLBACK_VIEWPORT,
  rowHeight = 22,
  onFileActivate,
  toolbar = true,
  className,
}: DiffViewProps) {
  const [uncontrolledMode, setUncontrolledMode] = useState<DiffMode>(defaultMode);
  const mode = controlledMode ?? uncontrolledMode;
  const rows = useMemo(() => buildRows(files, mode), [files, mode]);
  const columns = mode === "unified" ? 3 : 4;
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(typeof height === "number" ? height : FALLBACK_VIEWPORT);
  const [active, setActive] = useState(0);
  const idPrefix = useId();
  const rowId = (index: number) => `${idPrefix}-r${index}`;

  const totals = useMemo(
    () =>
      files.reduce(
        (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  );

  // Keep the active row valid when the rows change (new diff, mode switch).
  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      if (element.clientHeight > 0) setViewportHeight(element.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const first = Math.min(rows.length, Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN));
  const last = Math.min(rows.length, Math.floor(scrollTop / rowHeight) + visibleCount + OVERSCAN);
  // Keep the active row in the DOM for aria-activedescendant without rendering
  // every intervening row when the user scrolls away from it.
  const windows = first < last ? [{ start: first, end: last }] : [];
  if (active < first) windows.unshift({ start: active, end: active + 1 });
  else if (active >= last && active < rows.length) windows.push({ start: active, end: active + 1 });

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const moveTo = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setActive(next);
    const element = viewport.current;
    if (!element) return;
    const top = next * rowHeight;
    const bottom = top + rowHeight;
    const visibleHeight = element.clientHeight || viewportHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + visibleHeight) element.scrollTop = bottom - visibleHeight;
    setScrollTop(element.scrollTop);
  };

  const activate = (index: number) => {
    const row = rows[index];
    if (row?.type === "file") onFileActivate?.(row.file, row.fileIndex);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const handled: Record<string, () => void> = {
      ArrowDown: () => moveTo(active + 1),
      ArrowUp: () => moveTo(active - 1),
      PageDown: () => moveTo(active + visibleCount),
      PageUp: () => moveTo(active - visibleCount),
      Home: () => moveTo(0),
      End: () => moveTo(rows.length - 1),
      n: () => moveTo(nextSection(rows, active, 1)),
      p: () => moveTo(nextSection(rows, active, -1)),
      Enter: () => activate(active),
    };
    const action = handled[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  const setMode = (next: DiffMode) => {
    if (controlledMode === undefined) setUncontrolledMode(next);
    onModeChange?.(next);
  };

  return (
    <div className={cx(styles.root, className)}>
      {toolbar ? (
        <div className={styles.toolbar}>
          <p className={styles.summary}>
            <span>
              {files.length} {files.length === 1 ? "file" : "files"}
            </span>
            <span className={styles.additions}>
              <span aria-hidden="true">+</span>
              {totals.additions}
              <span className="visually-hidden"> lines added</span>
            </span>
            <span className={styles.deletions}>
              <span aria-hidden="true">−</span>
              {totals.deletions}
              <span className="visually-hidden"> lines removed</span>
            </span>
          </p>
          <SegmentedControl<DiffMode> aria-label="Diff layout" value={mode} options={MODES} onValueChange={setMode} />
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p className={styles.empty}>No changes.</p>
      ) : (
        <div
          ref={viewport}
          className={cx(styles.viewport, mode === "split" && styles.split)}
          style={{ height, ["--diff-row-h" as string]: `${rowHeight}px` }}
          onScroll={onScroll}
        >
          <table
            className={styles.table}
            style={{ height: rows.length * rowHeight }}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the WAI-ARIA data grid pattern is a <table role="grid">.
            role="grid"
            aria-label={label}
            aria-rowcount={rows.length}
            aria-colcount={columns}
            aria-readonly="true"
            aria-activedescendant={rowId(active)}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onClick={(event) => {
              const row = (event.target as Element).closest("tr");
              const index = Number(row?.getAttribute("aria-rowindex")) - 1;
              if (Number.isInteger(index) && index >= 0) {
                setActive(index);
                activate(index);
              }
            }}
          >
            {windows.map(({ start, end }) => (
              <tbody key={start} className={styles.window} style={{ transform: `translateY(${start * rowHeight}px)` }}>
                {rows.slice(start, end).map((row, offset) => {
                  const index = start + offset;
                  return (
                    <Row
                      key={row.key}
                      row={row}
                      id={rowId(index)}
                      rowIndex={index + 1}
                      columns={columns}
                      active={index === active}
                    />
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      )}
      {truncated ? (
        <p className={styles.truncated} role="status">
          This diff reached its size limit. Files after the cut are listed without their lines.
        </p>
      ) : null}
    </div>
  );
}

interface RowProps {
  row: DiffRow;
  id: string;
  rowIndex: number;
  columns: number;
  active: boolean;
}

function Row({ row, id, rowIndex, columns, active }: RowProps) {
  const common = {
    id,
    "aria-rowindex": rowIndex,
    "data-active": active ? "true" : undefined,
  } as const;
  switch (row.type) {
    case "file": {
      const { file } = row;
      const renamed = file.oldPath && file.oldPath !== file.path;
      return (
        <tr {...common} className={cx(styles.row, styles.fileRow)}>
          <th scope="row" colSpan={columns} className={styles.fileHeader}>
            <span className={cx(styles.change, styles[`change_${file.change}`])}>{CHANGE_LABEL[file.change]}</span>
            <span className={styles.path} title={file.path}>
              {renamed ? `${file.oldPath} → ${file.path}` : file.path}
            </span>
            <span className={styles.counts}>
              <span className={styles.additions}>
                <span aria-hidden="true">+</span>
                {file.additions}
                <span className="visually-hidden"> added</span>
              </span>
              <span className={styles.deletions}>
                <span aria-hidden="true">−</span>
                {file.deletions}
                <span className="visually-hidden"> removed</span>
              </span>
            </span>
          </th>
        </tr>
      );
    }
    case "hunk":
      return (
        <tr {...common} className={cx(styles.row, styles.hunkRow)}>
          <td colSpan={columns} className={styles.hunk}>
            {row.header}
          </td>
        </tr>
      );
    case "notice":
      return (
        <tr {...common} className={cx(styles.row, styles.noticeRow)}>
          <td colSpan={columns} className={styles.notice}>
            {NOTICE_TEXT[row.notice]}
          </td>
        </tr>
      );
    case "line":
      return (
        <tr {...common} className={cx(styles.row, styles[`line_${row.line.kind}`])}>
          <td className={styles.num}>{row.line.oldLine ?? ""}</td>
          <td className={styles.num}>{row.line.newLine ?? ""}</td>
          <Code line={row.line} />
        </tr>
      );
    case "pair":
      return (
        <tr {...common} className={styles.row}>
          <td className={cx(styles.num, row.left && styles[`side_${row.left.kind}`])}>{row.left?.oldLine ?? ""}</td>
          <Code line={row.left} side />
          <td className={cx(styles.num, row.right && styles[`side_${row.right.kind}`])}>{row.right?.newLine ?? ""}</td>
          <Code line={row.right} side />
        </tr>
      );
  }
}

function Code({ line, side = false }: { line: DiffLine | null; side?: boolean }) {
  if (!line) {
    return <td className={cx(styles.code, styles.filler)} />;
  }
  return (
    <td
      className={cx(styles.code, side && styles[`side_${line.kind}`], line.kind === "no_newline" && styles.noNewline)}
      title={side ? line.text : undefined}
    >
      <span className={styles.marker} aria-hidden="true">
        {MARKER[line.kind]}
      </span>
      <span className="visually-hidden">{KIND_LABEL[line.kind]}: </span>
      {line.kind === "no_newline" ? line.text || "No newline at end of file" : line.text}
    </td>
  );
}

export type { DiffFileData, DiffHunk, DiffLine, DiffMode } from "./DiffView.model.ts";
