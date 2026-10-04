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
  Bot,
  BroomSparkles,
  Check,
  CheckCheck,
  ChevronDown,
  CircleX,
  Equal,
  LayoutGrid,
  ListChecks,
  Minimize2,
  PlugZap,
  Plus,
  PowerOff,
  Save,
  Settings2,
  SquareTerminal,
  Trash2,
  Undo2,
} from "lucide-react";
import { type FormEvent, memo, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { formatShortcut } from "../../platform/keyboard.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { TASK_DESCRIPTIONS, TASK_LABELS, TASK_LAYOUTS } from "../../shell/panes/adaptiveCanvas.ts";
import {
  BUILTIN_PRESETS,
  type BuiltinPreset,
  contentKey,
  leaves,
  matchingPreset,
  PRESET_PANES,
} from "../../shell/panes/model.ts";
import { PANE_SHORTCUT_LABELS } from "../../shell/panes/paneShortcuts.ts";
import { CodeIntegrationPanel } from "../integrations/IntegrationSettings.tsx";
import styles from "./Code.module.css";
import { CodeCanvas, type CodeCanvasApi } from "./CodeCanvas.tsx";
import { CodeEmpty } from "./CodeEmpty.tsx";
import { useKalTidy } from "./kaltidy/kalTidyContext.ts";
import { HappeningStrip } from "./organization/HappeningStrip.tsx";
import { AgentCounters, BrowserButton, FocusButton, RunTestsButton, WidgetsMenu } from "./organization/QuickBar.tsx";
import { TerminalStack } from "./organization/TerminalStack.tsx";
import { CODE_SHORTCUT_LABELS, codeShortcut } from "./shortcuts.ts";
import { WorkspaceMenuContent } from "./WorkspaceMenu.tsx";

/** The Code surface: the active workspace as one flexible pane canvas (Z7-W1). */
export function CodePage() {
  const { state, error, active, retry, refresh } = useWorkspaces();
  // Code stays mounted while other pages are shown (Shell). Folder availability can change
  // outside KalCode; re-read it in the background whenever Code is shown.
  const shown = useNavigation().current === "code";
  useEffect(() => {
    if (shown) void refresh();
  }, [refresh, shown]);

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

/**
 * One workspace. The canvas stays mounted even while the folder is missing: availability can
 * flip for a single refresh (a sleeping drive, a network share), and unmounting would rebuild
 * every terminal. The missing-folder state covers the canvas instead.
 */
function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  return (
    <CodeCanvas workspace={workspace}>
      {(api, canvas) => (
        <div className={styles.code} data-workspace-id={workspace.id}>
          {api ? <CodeShortcuts api={api} /> : null}
          <header className={styles.header}>
            <WorkspaceTitle workspace={workspace} />
            <div className={styles.headerActions} id="code-actions" tabIndex={-1}>
              <Button
                icon={<PlugZap />}
                aria-expanded={integrationsOpen}
                onClick={() => setIntegrationsOpen((open) => !open)}
              >
                Tools
              </Button>
              {api ? <Toolbar api={api} available={workspace.available} /> : <ToolbarPlaceholder />}
            </div>
          </header>
          {integrationsOpen ? <CodeIntegrationPanel workspaceId={workspace.id} /> : null}
          <div className={styles.canvasArea}>
            {api ? <TerminalStack organization={api.organization} controller={api.controller} /> : null}
            {canvas}
            {workspace.available ? null : <MissingFolder workspace={workspace} />}
          </div>
          {api ? (
            <StatusBar api={api} workspaceId={workspace.id} />
          ) : (
            <div className={styles.statusBar} aria-hidden="true" />
          )}
        </div>
      )}
    </CodeCanvas>
  );
}

/** The workspace name is the switcher: it lists workspaces and opens folders. */
function WorkspaceTitle({ workspace }: { workspace: Workspace }) {
  return (
    <div className={styles.heading}>
      <DropdownMenu>
        <h1 className={styles.title}>
          <Tooltip content="Switch workspace or open a folder" side="bottom">
            <DropdownMenuTrigger asChild>
              <button type="button" className={styles.switcher}>
                <span className={styles.switcherName}>{workspace.name}</span>
                <ChevronDown className={styles.switcherChevron} aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
          </Tooltip>
        </h1>
        <WorkspaceMenuContent align="start" />
      </DropdownMenu>
      {workspace.available ? null : <Badge tone="waiting">Folder not found</Badge>}
      <span className={styles.path} title={workspace.rootPath} data-selectable>
        {workspace.displayPath}
      </span>
    </div>
  );
}

function MissingFolder({ workspace }: { workspace: Workspace }) {
  const { openFolder, picking, remove } = useWorkspaces();
  return (
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
          {workspace.displayPath} was moved or deleted outside KalCode. Terminals can't start until it's back. Removing
          the workspace only forgets it here.
        </p>
      </ErrorState>
    </div>
  );
}

/**
 * Code's terminal shortcuts, on panes: Ctrl+Tab / Ctrl+Shift+Tab cycle the focused pane's tabs,
 * Ctrl+Shift+W closes its tab (closing a terminal's tab ends its shell, as the tab's close does),
 * Ctrl+Shift+E leaves the terminal for its tab. They work inside terminals too, but never behind
 * an open dialog or menu.
 */
function CodeShortcuts({ api }: { api: CodeCanvasApi }) {
  const latest = useRef(api);
  latest.current = api;
  // Code stays mounted (hidden) on other pages; its shortcuts act only while it is shown.
  const shown = useRef(true);
  shown.current = useNavigation().current === "code";
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !shown.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
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
        tab?.querySelector<HTMLElement>("[data-tab-close]")?.click();
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

/** Same platform-aware chord as the pane shortcuts (Ctrl Alt n; ⌃ ⌥ n on macOS). */
const presetShortcut = (preset: BuiltinPreset) => formatShortcut(["Control", "Alt", String(PRESET_PANES[preset])]);

/** One control made of a main action and its menu, joined by a hairline. */
function SplitControl({ children }: { children: ReactNode }) {
  return <div className={styles.split}>{children}</div>;
}

/** The header before the panes have loaded: the same footprint, nothing to act on yet. */
function ToolbarPlaceholder() {
  return (
    <div className={styles.toolbar}>
      <SplitControl>
        <IconButton size="sm" className={styles.splitPart} label="New terminal" icon={<Plus />} disabled />
        <IconButton size="sm" className={styles.splitPart} label="Choose a shell" icon={<ChevronDown />} disabled />
      </SplitControl>
    </div>
  );
}

const Toolbar = memo(function Toolbar({ api, available }: { api: CodeCanvasApi; available: boolean }) {
  const { client } = useRuntime();
  const { controller, shells, background, providerPanes } = api;
  const [presets, setPresets] = useState<SavedLayoutPreset[]>([]);
  const [managing, setManaging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const chose = useRef(false);
  const current = matchingPreset(controller.layout);
  const maximized = controller.layout.maximizedPaneId !== null;
  const noShells = shells.length === 0 || !available;

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
    <div className={styles.toolbar}>
      {providerPanes.error ? (
        <span className={styles.toolError} role="alert" title={providerPanes.error}>
          {providerPanes.error}
        </span>
      ) : null}
      {background.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={styles.backgroundButton}
              aria-label={`${background.length} in background`}
            >
              <span className={styles.backgroundDot} aria-hidden="true" />
              <span className={styles.backgroundCount}>{background.length}</span>
              <span className={styles.collapsibleLabel}>in background</span>
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" minWidth={16}>
            <DropdownMenuLabel>Running, not in a pane</DropdownMenuLabel>
            {background.map((item) => (
              <DropdownMenuItem
                key={contentKey(item.content)}
                icon={<span className={styles.menuDot} data-tone={item.tone} />}
                onSelect={() => controller.show(item.content, { focus: true })}
              >
                {`Show ${item.title}`}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <AgentCounters controller={controller} organization={api.organization} />
      {providerPanes.enabled ? (
        <Tooltip content="Launch Claude Code, Codex or Gemini CLI in a pane">
          <Button
            size="sm"
            variant="primary"
            className={styles.primaryAction}
            icon={<Bot />}
            aria-label="New agent"
            busy={providerPanes.creating}
            onClick={() => api.openAgentLauncher()}
          >
            <span className={styles.agentLabel}>New agent</span>
          </Button>
        </Tooltip>
      ) : null}
      <SplitControl>
        <Tooltip content={`New ${defaultShell?.name ?? "terminal"} terminal (${CODE_SHORTCUT_LABELS["new-terminal"]})`}>
          <Button
            size="sm"
            variant="ghost"
            className={styles.splitPart}
            aria-label="New terminal"
            icon={<SquareTerminal />}
            disabled={noShells}
            onClick={() => api.newTerminal(null)}
          >
            <span className={styles.collapsibleLabel}>Terminal</span>
          </Button>
        </Tooltip>
        <DropdownMenu>
          <Tooltip content="Choose a shell">
            <DropdownMenuTrigger asChild>
              <IconButton
                size="sm"
                className={styles.splitPart}
                label="Choose a shell"
                icon={<ChevronDown />}
                disabled={noShells}
              />
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
      </SplitControl>
      <BrowserButton controller={controller} />
      <WidgetsMenu controller={controller} />
      <RunTestsButton controller={controller} organization={api.organization} />
      <KalTidyActions />
      <FocusButton controller={controller} onFocus={() => api.applyTaskLayout("focus")} />
      <span className={styles.groupDivider} aria-hidden="true" />
      <Tooltip content="Arrange panes without stopping work. Undo restores your exact layout.">
        <Button size="sm" variant="ghost" icon={<LayoutGrid />} onClick={() => controller.tidy()}>
          Tidy
        </Button>
      </Tooltip>
      {controller.undoLayoutLabel ? (
        <Tooltip content={`Restore the arrangement before ${controller.undoLayoutLabel}`}>
          <IconButton
            size="sm"
            label={`Undo ${controller.undoLayoutLabel}`}
            icon={<Undo2 />}
            onClick={() => controller.undoLayout()}
          />
        </Tooltip>
      ) : null}
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) loadPresets();
          else setManaging(false);
        }}
      >
        <Tooltip content="Arrange, save and restore pane layouts">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" icon={<LayoutGrid />} aria-label="Layout">
              <span className={styles.collapsibleLabel}>Layout</span>
              <ChevronDown aria-hidden="true" className={styles.chevron} />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end" minWidth={17}>
          <DropdownMenuLabel>Adaptive Canvas</DropdownMenuLabel>
          {api.layoutSuggestion ? (
            <>
              <DropdownMenuItem
                icon={<LayoutGrid />}
                description={api.layoutSuggestion.reason}
                onSelect={() => {
                  if (api.layoutSuggestion) api.applyTaskLayout(api.layoutSuggestion.task);
                }}
              >
                {`Suggested: ${TASK_LABELS[api.layoutSuggestion.task]}`}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {TASK_LAYOUTS.map((task) => (
            <DropdownMenuItem
              key={task}
              icon={
                <span className={styles.layoutPreview} data-layout={task} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              }
              description={TASK_DESCRIPTIONS[task]}
              onSelect={() => api.applyTaskLayout(task)}
            >
              {TASK_LABELS[task]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Pane counts</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={current ?? ""}
            onValueChange={(value) => controller.preset(value as BuiltinPreset)}
          >
            {BUILTIN_PRESETS.map((preset) => (
              <DropdownMenuRadioItem key={preset} value={preset} shortcut={presetShortcut(preset)}>
                {PRESET_LABEL[preset]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {presets.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{managing ? "Delete saved layouts" : "Saved layouts"}</DropdownMenuLabel>
              {presets.map((preset) =>
                managing ? (
                  <DropdownMenuItem
                    key={preset.id}
                    icon={<Trash2 />}
                    tone="danger"
                    onSelect={(event) => {
                      // Stay open: several layouts can go in one visit.
                      event.preventDefault();
                      void deletePreset(preset);
                    }}
                  >
                    {`Delete ${preset.name}`}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    key={preset.id}
                    icon={<LayoutGrid />}
                    description={`${leaves(preset.layout.root).length} panes`}
                    onSelect={() => controller.applyShape(preset.layout.root, preset.name)}
                  >
                    {preset.name}
                  </DropdownMenuItem>
                ),
              )}
              <DropdownMenuItem
                icon={managing ? <Check /> : <Settings2 />}
                onSelect={(event) => {
                  event.preventDefault();
                  setManaging((value) => !value);
                }}
              >
                {managing ? "Done" : "Manage saved layouts…"}
              </DropdownMenuItem>
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
    </div>
  );
});

/**
 * KalTidy in Code: one click stops idle terminals; the menu offers the review first. More KalTidy
 * actions join the menu as items.
 */
function KalTidyActions() {
  const kalTidy = useKalTidy();
  const [tidying, setTidying] = useState(false);
  if (!kalTidy) return null;
  const stopIdle = async () => {
    setTidying(true);
    try {
      await kalTidy.stopIdle();
    } finally {
      setTidying(false);
    }
  };
  return (
    <SplitControl>
      <Tooltip content="KalTidy: Stop idle terminals">
        <IconButton
          size="sm"
          className={styles.splitPart}
          label="KalTidy: Stop idle terminals"
          icon={<BroomSparkles />}
          busy={tidying}
          onClick={() => void stopIdle()}
        />
      </Tooltip>
      <DropdownMenu>
        <Tooltip content="More KalTidy actions">
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" className={styles.splitPart} label="More KalTidy actions" icon={<ChevronDown />} />
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end" minWidth={17}>
          <DropdownMenuLabel>KalTidy</DropdownMenuLabel>
          <DropdownMenuItem
            icon={<BroomSparkles />}
            description="Only terminals that are idle and safe to close"
            disabled={tidying}
            onSelect={() => void stopIdle()}
          >
            Stop idle terminals
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<ListChecks />}
            description="See every terminal and choose what stops"
            onSelect={() => kalTidy.openReview()}
          >
            Review terminals…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={<CircleX />}
            description="Failed agents leave Code, the Fleet and Needs You"
            onSelect={() => void kalTidy.clearFailed()}
          >
            Clear failed agents
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<CheckCheck />}
            description="Finished and stopped agents; working ones stay"
            onSelect={() => void kalTidy.clearFinished()}
          >
            Clear finished agents
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={<PowerOff />}
            tone="danger"
            description="Asks once, then ends everything in this workspace"
            onSelect={() => kalTidy.closeAll()}
          >
            Close all terminals and agents…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SplitControl>
  );
}

/**
 * The foot of the canvas: What's Happening (observed facts about the workspace, each one opens
 * what it describes), then the focused pane, the pane count and the keys that drive panes (fewer as
 * the canvas narrows). The pane parts duplicate pane state, so they are not a live region.
 */
const StatusBar = memo(function StatusBar({ api, workspaceId }: { api: CodeCanvasApi; workspaceId: string }) {
  const { controller, titleOf } = api;
  const panes = leaves(controller.layout.root);
  const focused = panes.find((p) => p.paneId === controller.focusedPaneId);
  const content = focused?.tabs[focused.activeTab];
  return (
    <div className={styles.statusBar}>
      <HappeningStrip organization={api.organization} controller={controller} workspaceId={workspaceId} />
      <div className={styles.statusInfo} data-trailing>
        {content ? (
          <span className={styles.statusFocus}>
            <ProviderGlyph
              provider={
                content.kind === "agent"
                  ? (api.providerPanes.panes.find((p) => p.thread.id === content.agentId)?.thread.providerId ??
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
        {controller.saveState === "error" ? (
          <span className={styles.statusItem}>
            <StatusChip variant="inline" size="sm" tone="failed" label="Layout not saved" />
          </span>
        ) : null}
        <span className={styles.statusItem}>
          {panes.length} {panes.length === 1 ? "pane" : "panes"}
        </span>
      </div>
      <span className={styles.statusKeys} aria-hidden="true">
        <span data-key="move">
          <Kbd>{PANE_SHORTCUT_LABELS.focus}</Kbd> focus
        </span>
        <span data-key="split">
          <Kbd>{PANE_SHORTCUT_LABELS.splitRight}</Kbd> split
        </span>
        <span data-key="maximize">
          <Kbd>{PANE_SHORTCUT_LABELS.maximize}</Kbd> maximize
        </span>
        <span data-key="leave">
          <Kbd>{CODE_SHORTCUT_LABELS["leave-terminal"]}</Kbd> leave terminal
        </span>
      </span>
    </div>
  );
});
