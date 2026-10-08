import type { FileEntry, FileRef } from "@kalcode/protocol";
import { Skeleton } from "@kalcode/ui/components";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { ContentContextMenu } from "../../shell/context/ContentContextMenu.tsx";
import { FilePreview } from "../../shell/context/FilePreview.tsx";
import { FavoriteButton } from "../../shell/favorites/FavoriteActions.tsx";
import styles from "./Folder.module.css";
import { fileSize, splitPath } from "./folderModel.ts";
import { OwnerMarker, useOwnerLookup } from "./ownerMarker.tsx";

interface Listing {
  state: "loading" | "ready" | "error";
  entries: FileEntry[];
  truncated: boolean;
  error?: string;
}

interface Row {
  entry: FileEntry;
  level: number;
  key: string;
}

const PAGE = 200;

/**
 * The workspace's files from the Z6a index, folders first. The WebView never names a path:
 * each folder is listed through the opaque handle native returned for it (ADVANCED.md D4).
 * Ignored entries are shown dimmed and labelled.
 */
export function FileTree({ workspaceId }: { workspaceId: string }) {
  const { client } = useRuntime();
  const lifecycle = useMemo(() => ({ client, workspaceId, mounted: false, epoch: 0 }), [client, workspaceId]);
  const currentLifecycle = useRef(lifecycle);
  currentLifecycle.current = lifecycle;
  const isCurrent = useCallback(
    (epoch = lifecycle.epoch) =>
      lifecycle.mounted && currentLifecycle.current === lifecycle && epoch === lifecycle.epoch,
    [lifecycle],
  );
  const [listingState, setListingState] = useState({ lifecycle, listings: {} as Record<string, Listing> });
  // Mask old handles immediately, before the new workspace's effect runs.
  const listings = listingState.lifecycle === lifecycle ? listingState.listings : {};
  const setListing = useCallback(
    (key: string, listing: Listing) => {
      setListingState((previous) => ({
        lifecycle,
        listings: { ...(previous.lifecycle === lifecycle ? previous.listings : {}), [key]: listing },
      }));
    },
    [lifecycle],
  );
  const owners = useOwnerLookup(workspaceId);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileRef | null>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const focusFrame = useRef<number | null>(null);
  const focusGeneration = useRef(0);
  const cancelFocus = useCallback(() => {
    focusGeneration.current += 1;
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = null;
  }, []);

  useEffect(() => {
    lifecycle.mounted = true;
    setListingState({ lifecycle, listings: {} });
    setOpen(new Set());
    setFocusKey(null);
    setSelected(null);
    setPreview(null);
    return () => {
      lifecycle.mounted = false;
      lifecycle.epoch += 1;
      cancelFocus();
    };
  }, [lifecycle, cancelFocus]);

  const load = useCallback(
    async (key: string, entry: FileEntry | null) => {
      if (!isCurrent()) return;
      const epoch = lifecycle.epoch;
      setListing(key, { state: "loading", entries: [], truncated: false });
      try {
        const page = await client.listFiles(workspaceId, entry ? entry.file.handle : null, PAGE);
        if (!isCurrent(epoch)) return;
        setListing(key, { state: "ready", entries: page.items, truncated: page.nextCursor !== null });
      } catch (cause) {
        if (!isCurrent(epoch)) return;
        setListing(key, { state: "error", entries: [], truncated: false, error: toKalCodeError(cause).message });
      }
    },
    [client, workspaceId, lifecycle, isCurrent, setListing],
  );

  useEffect(() => {
    void load("", null);
  }, [load]);

  const visible = useMemo(() => {
    const out: Row[] = [];
    const walk = (key: string, level: number) => {
      for (const entry of listings[key]?.entries ?? []) {
        const childKey = entry.file.displayPath;
        out.push({ entry, level, key: childKey });
        if (entry.isDir && open.has(childKey)) walk(childKey, level + 1);
      }
    };
    walk("", 1);
    return out;
  }, [listings, open]);

  const toggle = (row: Row, expand?: boolean) => {
    if (!isCurrent() || !row.entry.isDir) return;
    const isOpen = open.has(row.key);
    const next = expand ?? !isOpen;
    if (next === isOpen) return;
    setOpen((current) => {
      const copy = new Set(current);
      if (next) copy.add(row.key);
      else copy.delete(row.key);
      return copy;
    });
    if (next && (!listings[row.key] || listings[row.key]?.state === "error")) void load(row.key, row.entry);
  };

  const focusRow = (key: string | undefined) => {
    if (!key || !isCurrent()) return;
    cancelFocus();
    const request = focusGeneration.current;
    const epoch = lifecycle.epoch;
    setFocusKey(key);
    focusFrame.current = requestAnimationFrame(() => {
      if (!isCurrent(epoch) || request !== focusGeneration.current) return;
      focusFrame.current = null;
      rows.current.get(key)?.focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const row = visible[index];
    if (!row) return;
    const move = (to: number) => {
      event.preventDefault();
      focusRow(visible[Math.max(0, Math.min(visible.length - 1, to))]?.key);
    };
    switch (event.key) {
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(visible.length - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (row.entry.isDir && !open.has(row.key)) toggle(row, true);
        else if (row.entry.isDir && (visible[index + 1]?.level ?? 0) > row.level) focusRow(visible[index + 1]?.key);
        break;
      case "ArrowLeft": {
        event.preventDefault();
        if (row.entry.isDir && open.has(row.key)) toggle(row, false);
        else {
          for (let i = index - 1; i >= 0; i--) {
            if ((visible[i]?.level ?? 0) < row.level) {
              focusRow(visible[i]?.key);
              break;
            }
          }
        }
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        if (row.entry.isDir) toggle(row);
        else setSelected(row.key);
        break;
      default:
        break;
    }
  };

  const root = listings[""];
  if (!root || root.state === "loading") {
    return (
      <div className={styles.treeLoading} aria-busy="true">
        <Skeleton width="40%" />
        <Skeleton width="55%" />
        <Skeleton width="35%" />
      </div>
    );
  }
  if (root.state === "error") {
    return (
      <ContentContextMenu
        workspaceId={workspaceId}
        context={{ kind: "error", label: "File listing error", text: root.error ?? "Could not list files" }}
      >
        <p className={styles.note} role="alert">
          {root.error}
        </p>
      </ContentContextMenu>
    );
  }
  if (visible.length === 0) {
    return <p className={styles.note}>This folder is empty.</p>;
  }
  const tabKey = visible.some((r) => r.key === focusKey) ? focusKey : visible[0]?.key;
  return (
    <>
      <div
        className={styles.fileTree}
        role="tree"
        aria-label="Files"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) cancelFocus();
        }}
      >
        {visible.map((row, index) => {
          const { entry } = row;
          const { name } = splitPath(entry.file.displayPath);
          const isOpen = open.has(row.key);
          const child = listings[row.key];
          const childNote =
            entry.isDir && isOpen
              ? child?.state === "loading"
                ? "Loading…"
                : child?.state === "error"
                  ? (child.error ?? "Couldn't list this folder")
                  : child?.state === "ready" && child.entries.length === 0
                    ? "empty"
                    : null
              : null;
          const held = owners ? (entry.isDir ? owners.folder(row.key) : owners.file(row.key)) : null;
          return (
            <ContentContextMenu
              key={row.key}
              workspaceId={workspaceId}
              favoriteTarget={entry.isDir ? null : { kind: "file", id: entry.file.displayPath, workspaceId }}
              context={{
                kind: "file",
                label: name,
                path: entry.file.displayPath,
                text: entry.isDir ? "Workspace folder" : "Workspace file",
              }}
              onOpen={() => {
                if (entry.isDir) toggle(row, true);
                else setPreview(entry.file);
              }}
            >
              <div
                ref={(el) => {
                  if (el) rows.current.set(row.key, el);
                  else rows.current.delete(row.key);
                }}
                role="treeitem"
                aria-level={row.level}
                aria-expanded={entry.isDir ? isOpen : undefined}
                aria-selected={selected === row.key}
                aria-busy={child?.state === "loading" || undefined}
                tabIndex={row.key === tabKey ? 0 : -1}
                className={styles.fileRow}
                style={{ paddingLeft: `calc(${row.level - 1} * 0.875rem + 0.375rem)` }}
                data-ignored={entry.ignored || undefined}
                data-selected={selected === row.key || undefined}
                aria-label={`${name}${entry.isDir ? ", folder" : ""}${entry.ignored ? ", ignored" : ""}${childNote === "empty" ? ", empty" : ""}${held ? `, ${held.label}` : ""}`}
                onClick={() => {
                  cancelFocus();
                  setFocusKey(row.key);
                  if (entry.isDir) toggle(row);
                  else setSelected(row.key);
                }}
                onKeyDown={(e) => onKeyDown(e, index)}
                onFocus={() => {
                  cancelFocus();
                  setFocusKey(row.key);
                }}
              >
                <span className={styles.fileCaret} data-open={isOpen || undefined} aria-hidden="true">
                  {entry.isDir ? <ChevronRight /> : null}
                </span>
                <span className={styles.fileIcon} aria-hidden="true">
                  {entry.isDir ? isOpen ? <FolderOpen /> : <Folder /> : <File />}
                </span>
                <span className={styles.fileName}>{name}</span>
                {held ? <OwnerMarker view={held} /> : null}
                {entry.ignored ? <span className={styles.ignored}>ignored</span> : null}
                {childNote ? <span className={styles.fileNote}>{childNote}</span> : null}
                {entry.isDir ? null : <span className={styles.fileSize}>{fileSize(entry.bytes)}</span>}
                {entry.isDir ? null : (
                  <FavoriteButton target={{ kind: "file", id: entry.file.displayPath, workspaceId }} title={name} />
                )}
              </div>
            </ContentContextMenu>
          );
        })}
      </div>
      {root.truncated ? <p className={styles.note}>Showing the first {PAGE} entries of this folder.</p> : null}
      {preview ? (
        <FilePreview
          file={preview}
          returnFocus={rows.current.get(preview.displayPath)}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </>
  );
}
