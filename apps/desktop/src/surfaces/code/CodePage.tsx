import type { SavedLayoutPreset, Workspace } from "@kalcode/protocol";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ErrorState,
  IconButton,
  Kbd,
  ProviderGlyph,
  Skeleton,
  StatusChip,
  TextInput,
  Tooltip,
} from "@kalcode/ui/components";
import {
  ChevronDown,
  Equal,
  FolderOpen,
  LayoutGrid,
  Minimize2,
  Plus,
  Save,
  SquareTerminal,
  Trash2,
  Undo2,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import {
  BUILTIN_PRESETS,
  type BuiltinPreset,
  contentKey,
  leaves,
  matchingPreset,
  PRESET_PANES,
} from "../../shell/panes/model.ts";
import { PANE_SHORTCUT_LABELS } from "../../shell/panes/paneShortcuts.ts";
import styles from "./Code.module.css";
import { CodeCanvas, type CodeCanvasApi } from "./CodeCanvas.tsx";
import { CodeEmpty } from "./CodeEmpty.tsx";
import { providerIdentity } from "./panes/paneLabels.ts";
import { CODE_SHORTCUT_LABELS, codeShortcut } from "./shortcuts.ts";
import { WorkspaceMenuContent } from "./WorkspaceMenu.tsx";

/** The Code surface: the active workspace as one flexible pane canvas (Z7-W1). */
export function CodePage() {
  const { state, error, active, retry, refresh } = useWorkspaces();
  // Folder availability can change outside KalCode; re-read it whenever Code is shown.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (state === "loading") {
    return (
      <div className={styles.loading} role="status" aria-busy="true">
        <span className="visually-hidden">Loading workspaces</span>
        <Skeleton width="14rem" height="1.5rem" />
        <Skeleton width="20rem" />
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className={styles.loading}>
        <h1 className="visually-hidden">Code</h1>
        <ErrorState
          title="Workspaces couldn't load"
          code={error ? `${error.category}/${error.code}` : undefined}
          actions={<Button onClick={retry}>Try again</Button>}
        >
          <p>{error?.message ?? "KalCode couldn't read its workspaces."} Your folders are unchanged.</p>
        </ErrorState>
      </div>
    );
  }
  return active ? <WorkspaceView key={active.id} workspace={active} /> : <CodeEmpty />;
}

function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const { openFolder, picking, remove } = useWorkspaces();

  const header = (toolbar: ReactNode) => (
    <header className={styles.header}>
      <div className={styles.heading}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{workspace.name}</h1>
          {workspace.available ? null : <Badge tone="waiting">Folder not found</Badge>}
        </div>
        <p className={styles.path} title={workspace.rootPath} data-selectable>
          {workspace.displayPath}
        </p>
      </div>
      <div className={styles.headerActions} id="code-actions" tabIndex={-1}>
        {toolbar}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              Switch workspace
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <WorkspaceMenuContent align="end" />
        </DropdownMenu>
        <Button size="sm" icon={<FolderOpen />} onClick={() => void openFolder()} busy={picking}>
          Open folder…
        </Button>
      </div>
    </header>
  );

  if (!workspace.available) {
    return (
      <div className={styles.code}>
        {header(
          <div className={styles.toolGroup}>
            <IconButton size="sm" label="New terminal" icon={<Plus />} disabled />
            <IconButton size="sm" label="Choose a shell" icon={<ChevronDown />} disabled />
          </div>,
        )}
        <div className={styles.canvasArea}>
          <div className={styles.missing}>
            <ErrorState
              title="This folder can't be found"
              actions={
                <>
                  <Button onClick={() => void openFolder()} busy={picking}>
                    Open another folder…
                  </Button>
                  <Button variant="ghost" onClick={() => void remove(workspace)}>
                    Remove from KalCode
                  </Button>
                </>
              }
            >
              <p>
                {workspace.displayPath} was moved or deleted outside KalCode. Terminals can't start until it's back.
                Removing the workspace only forgets it here.
              </p>
            </ErrorState>
          </div>
        </div>
      </div>
    );
  }

  return (
    <CodeCanvas workspace={workspace}>
      {(api, canvas) => (
        <div className={styles.code} data-workspace-id={workspace.id}>
          <CodeShortcuts api={api} />
          {header(<Toolbar api={api} />)}
          <div className={styles.canvasArea}>{canvas}</div>
          <StatusBar api={api} />
        </div>
      )}
    </CodeCanvas>
  );
}

/**
 * Code's terminal shortcuts, on panes: Ctrl+Tab / Ctrl+Shift+Tab cycle the focused pane's tabs,
 * Ctrl+Shift+W closes its tab (what it runs keeps running), Ctrl+Shift+E leaves the terminal for
 * its tab. They work inside terminals too.
 */
function CodeShortcuts({ api }: { api: CodeCanvasApi }) {
  const latest = useRef(api);
  latest.current = api;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcut = codeShortcut(event);
      if (!shortcut || shortcut === "new-terminal") return; // new terminal is global (Shell)
      const { controller } = latest.current;
      const paneId = controller.focusedPaneId;
      const leaf = leaves(controller.layout.root).find((l) => l.paneId === paneId);
      event.preventDefault();
      if (!leaf) return;
      if (shortcut === "next-tab" || shortcut === "previous-tab") {
        controller.cycleTab(shortcut === "next-tab" ? 1 : -1);
      } else if (shortcut === "close-tab") {
        const tab = document.querySelector<HTMLElement>(
          `#pane-${CSS.escape(leaf.paneId)} [role="tab"][aria-selected="true"]`,
        );
        // The tab's own close (an ended shell tidies away; anything running keeps running).
        tab?.querySelector<HTMLElement>('[class*="tabClose"]')?.click();
      } else if (shortcut === "leave-terminal") {
        const tab = document.querySelector<HTMLElement>(
          `#pane-${CSS.escape(leaf.paneId)} [role="tab"][aria-selected="true"]`,
        );
        (tab ?? document.getElementById("code-actions"))?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return null;
}

const PRESET_LABEL: Record<BuiltinPreset, string> = {
  two: "2 panes",
  three: "3 panes",
  four: "4 panes (2 × 2)",
  six: "6 panes (3 × 2)",
};

function Toolbar({ api }: { api: CodeCanvasApi }) {
  const { client } = useRuntime();
  const { controller, shells, background, providerPanes } = api;
  const [presets, setPresets] = useState<SavedLayoutPreset[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const chose = useRef(false);
  const current = matchingPreset(controller.layout);
  const maximized = controller.layout.maximizedPaneId !== null;

  const loadPresets = () => {
    client
      .layoutPresets()
      .then(setPresets)
      .catch(() => setPresets([]));
  };

  const savePreset = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const saved = await client.layoutPresetSave(name, controller.layout);
      setPresets((list) => [...list, saved]);
      controller.announce(`Saved the layout as ${saved.name}.`);
      setSaving(false);
      setName("");
      setError(null);
    } catch (cause) {
      setError(toKalCodeError(cause).message);
    }
  };

  const deletePreset = async (preset: SavedLayoutPreset) => {
    try {
      await client.layoutPresetDelete(preset.id);
      setPresets((list) => list.filter((p) => p.id !== preset.id));
      controller.announce(`Deleted the ${preset.name} layout.`);
    } catch (cause) {
      controller.announce(toKalCodeError(cause).message);
    }
  };

  if (saving) {
    return (
      <form className={styles.saveForm} onSubmit={(e) => void savePreset(e)} aria-label="Save this layout">
        <label className="visually-hidden" htmlFor={inputId}>
          Layout name
        </label>
        <TextInput
          id={inputId}
          value={name}
          maxLength={60}
          placeholder="Layout name"
          autoFocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setSaving(false);
              setError(null);
            }
          }}
        />
        {error ? (
          <span id={`${inputId}-error`} className={styles.saveError} role="alert">
            {error}
          </span>
        ) : null}
        <Button size="sm" type="submit" variant="primary" disabled={!name.trim()}>
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setSaving(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </form>
    );
  }

  const defaultShell = shells.find((s) => s.isDefault) ?? shells[0];
  return (
    <>
      <div className={styles.toolGroup}>
        <Tooltip content={`New ${defaultShell?.name ?? "terminal"} terminal (${CODE_SHORTCUT_LABELS["new-terminal"]})`}>
          <IconButton
            size="sm"
            label="New terminal"
            icon={<Plus />}
            disabled={shells.length === 0}
            onClick={() => api.newTerminal(null)}
          />
        </Tooltip>
        <DropdownMenu>
          <Tooltip content="Choose a shell">
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" label="Choose a shell" icon={<ChevronDown />} disabled={shells.length === 0} />
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent
            align="end"
            minWidth={14}
            onCloseAutoFocus={(event) => {
              if (chose.current) event.preventDefault();
              chose.current = false;
            }}
          >
            <DropdownMenuLabel>New terminal</DropdownMenuLabel>
            {shells.map((shell) => (
              <DropdownMenuItem
                key={shell.id}
                icon={<SquareTerminal />}
                description={shell.isDefault ? "Default" : undefined}
                onSelect={() => {
                  chose.current = true;
                  api.newTerminal(shell.id);
                }}
              >
                {shell.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {providerPanes.enabled ? (
        <Button
          size="sm"
          icon={<ProviderGlyph provider="claude-code" size="xs" />}
          busy={providerPanes.creatingProvider === "claude-code"}
          disabled={providerPanes.creating && providerPanes.creatingProvider !== "claude-code"}
          onClick={() => void api.newProviderPane()}
        >
          New Claude Code pane
        </Button>
      ) : null}
      {providerPanes.enabled
        ? providerPanes.offered.map((providerId) => (
            <Button
              key={providerId}
              size="sm"
              icon={<ProviderGlyph provider={providerId} size="xs" />}
              busy={providerPanes.creatingProvider === providerId}
              disabled={providerPanes.creating && providerPanes.creatingProvider !== providerId}
              onClick={() => void api.newProviderPane(providerId)}
            >
              {`New ${providerIdentity(providerId).name} pane`}
            </Button>
          ))
        : null}
      {providerPanes.error ? (
        <span className={styles.toolError} role="alert">
          {providerPanes.error}
        </span>
      ) : null}
      <DropdownMenu onOpenChange={(open) => open && loadPresets()}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" icon={<LayoutGrid />}>
            Layout
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" minWidth={17}>
          <DropdownMenuLabel>Arrange panes</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={current ?? ""}
            onValueChange={(value) => controller.preset(value as BuiltinPreset)}
          >
            {BUILTIN_PRESETS.map((preset) => (
              <DropdownMenuRadioItem key={preset} value={preset} shortcut={`Ctrl Alt ${PRESET_PANES[preset]}`}>
                {PRESET_LABEL[preset]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {presets.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Saved layouts</DropdownMenuLabel>
              {presets.map((preset) => (
                <DropdownMenuItem
                  key={preset.id}
                  icon={<LayoutGrid />}
                  description={`${leaves(preset.layout.root).length} panes`}
                  onSelect={() => controller.applyShape(preset.layout.root, preset.name)}
                >
                  {preset.name}
                </DropdownMenuItem>
              ))}
              {presets.map((preset) => (
                <DropdownMenuItem
                  key={`delete-${preset.id}`}
                  icon={<Trash2 />}
                  tone="danger"
                  onSelect={() => void deletePreset(preset)}
                >
                  {`Delete ${preset.name}`}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<Save />} onSelect={() => setSaving(true)}>
            Save this layout…
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Equal />} shortcut={PANE_SHORTCUT_LABELS.even} onSelect={() => controller.even()}>
            Even out sizes
          </DropdownMenuItem>
          {maximized ? (
            <DropdownMenuItem icon={<Minimize2 />} onSelect={() => controller.restore()}>
              Restore layout
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            icon={<Undo2 />}
            shortcut={PANE_SHORTCUT_LABELS.reopen}
            disabled={controller.closed.length === 0}
            description={controller.closed.length > 0 ? `${controller.closed.length} closed` : undefined}
            onSelect={() => controller.reopen()}
          >
            Reopen closed pane
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {background.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <span className={styles.backgroundDot} aria-hidden="true" />
              {`${background.length} in background`}
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" minWidth={16}>
            <DropdownMenuLabel>Running, not in a pane</DropdownMenuLabel>
            {background.map((item) => (
              <DropdownMenuItem
                key={contentKey(item.content)}
                icon={<SquareTerminal />}
                onSelect={() => controller.show(item.content, { focus: true })}
              >
                {`Show ${item.title}`}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  );
}

/**
 * The foot of the canvas: the focused pane and its state, pane and process counts, and the
 * keys that drive panes. Decorative duplicate of pane state, so it is not a live region (the
 * canvas announces changes itself).
 */
function StatusBar({ api }: { api: CodeCanvasApi }) {
  const { controller, background, titleOf } = api;
  const panes = leaves(controller.layout.root);
  const focused = panes.find((p) => p.paneId === controller.focusedPaneId);
  const content = focused?.tabs[focused.activeTab];
  const running = api.providerPanes.panes.filter((p) => p.info.running).length;
  const terminalsRunning = useWorkspaces().terminals.filter((t) => t.status === "running").length;
  return (
    <div className={styles.statusBar}>
      {content ? (
        <span className={styles.statusItem}>
          <ProviderGlyph
            provider={
              content.kind === "thread"
                ? (api.providerPanes.panes.find((p) => p.thread.id === content.threadId)?.thread.providerId ??
                  "generic")
                : content.kind === "terminal"
                  ? "shell"
                  : "generic"
            }
            size="xs"
          />
          <span className={styles.statusStrong}>{titleOf(content)}</span>
        </span>
      ) : null}
      <span className={styles.statusItem}>
        {panes.length} {panes.length === 1 ? "pane" : "panes"} · {terminalsRunning + running} running
        {background.length > 0 ? ` · ${background.length} in background` : ""}
      </span>
      {controller.saveState === "error" ? (
        <StatusChip variant="inline" size="sm" tone="failed" label="Layout not saved" />
      ) : null}
      <span className={styles.statusKeys} aria-hidden="true">
        <span>
          <Kbd>{PANE_SHORTCUT_LABELS.focus}</Kbd> move
        </span>
        <span>
          <Kbd>{PANE_SHORTCUT_LABELS.splitRight}</Kbd> split
        </span>
        <span>
          <Kbd>{PANE_SHORTCUT_LABELS.maximize}</Kbd> maximize
        </span>
        <span>
          <Kbd>{CODE_SHORTCUT_LABELS["leave-terminal"]}</Kbd> leave terminal
        </span>
      </span>
    </div>
  );
}
