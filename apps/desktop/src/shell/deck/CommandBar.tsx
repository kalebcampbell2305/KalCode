/**
 * The Command Deck's top bar: where you are (workspace, Git branch, environment), how agents may
 * act (permission mode), the global command/search field, and the two live signals that answer
 * "what is working?" and "what needs me?".
 */
import type { PermissionMode } from "@kalcode/protocol";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from "@kalcode/ui/components";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FolderClosed,
  GitBranch,
  Globe,
  Search,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { forwardRef, type ReactNode, useMemo, useState } from "react";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { WorkspaceMenuContent } from "../../surfaces/code/WorkspaceMenu.tsx";
import { useCodingAgents } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { focusSection, useNow } from "../../surfaces/dashboard/useNow.ts";
import { DEFAULT_MODE_CHOICES, MODE_DESCRIPTIONS, MODE_LABELS } from "../../surfaces/permissions/labels.ts";
import { usePermissions } from "../../surfaces/permissions/PermissionsProvider.tsx";
import { Mark, Wordmark } from "../Brand.tsx";
import { useNavigation, viewVisible } from "../navigation.tsx";
import { allEntries } from "../rail/model.ts";
import { RailDialogs } from "../rail/RailDialogs.tsx";
import { useRail } from "../rail/RailProvider.tsx";
import type { RailDialog } from "../rail/RailTree.tsx";
import { WorkspaceContextMenu } from "../rail/WorkspaceContextMenu.tsx";
import { MOD_LABEL } from "../shortcuts.ts";
import { AccountUsageCenter } from "./AccountUsageCenter.tsx";
import styles from "./CommandBar.module.css";
import { useDeckData } from "./DeckData.tsx";
import { useDeckUi } from "./DeckUi.tsx";
import {
  agentSections,
  ago,
  ENVIRONMENT_LABELS,
  environmentTone,
  humanize,
  needsChipTarget,
  needsYouCount,
  primaryEnvironment,
} from "./deckModel.ts";

export function CommandBar({
  onOpenPalette,
  sidebarCollapsed,
}: {
  onOpenPalette: () => void;
  sidebarCollapsed: boolean;
}) {
  return (
    <header className={styles.bar} data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}>
      <div className={styles.brand}>
        <Mark size={20} />
        <Wordmark className={styles.wordmark} />
      </div>
      <div className={styles.context}>
        <WorkspaceChip />
        <BranchChip />
        <EnvironmentChip />
        <ModeChip />
      </div>
      <div className={styles.center}>
        <button type="button" className={styles.command} onClick={onOpenPalette} aria-keyshortcuts="Control+K Meta+K">
          <Search className={styles.commandIcon} aria-hidden="true" />
          <span className={styles.commandText}>Search or run a command</span>
          <kbd className={styles.kbd}>{MOD_LABEL} K</kbd>
        </button>
      </div>
      <div className={styles.actions}>
        <Signals />
        <AccountUsageCenter />
      </div>
    </header>
  );
}

// ---- Context chips ----

interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  caption: string;
  children: ReactNode;
  tone?: string;
  menu?: boolean;
}

const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { icon, caption, children, tone, menu = false, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={[styles.chip, className].filter(Boolean).join(" ")}
      data-tone={tone}
      {...rest}
    >
      <span className={styles.chipIcon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.chipText}>
        <span className={styles.chipCaption}>{caption}</span>
        <span className={styles.chipValue}>{children}</span>
      </span>
      {menu ? <ChevronDown className={styles.chipChevron} aria-hidden="true" /> : null}
    </button>
  );
});

function WorkspaceChip() {
  const { active, state, workspaces, openFolder, picking } = useWorkspaces();
  const { navigate } = useNavigation();
  const rail = useRail();
  const [dialog, setDialog] = useState<RailDialog | null>(null);
  const entry = rail.rail ? allEntries(rail.rail).find((workspace) => workspace.workspaceId === active?.id) : null;
  const name = active?.name ?? "No workspace";
  // With no workspaces the menu would hold one choice, so the chip opens the folder picker itself.
  if (state === "ready" && workspaces.length === 0) {
    return (
      <Tooltip content="Open a project folder">
        <Chip
          icon={<FolderClosed />}
          caption="Workspace"
          disabled={picking}
          aria-label="Workspace: none. Open a project folder"
          data-empty
          onClick={() =>
            void openFolder().then((opened) => {
              if (opened) navigate("code");
            })
          }
        >
          {name}
        </Chip>
      </Tooltip>
    );
  }
  const trigger = (
    <DropdownMenuTrigger asChild>
      <Chip
        icon={<FolderClosed />}
        caption="Workspace"
        menu
        disabled={state === "loading"}
        aria-label={`Workspace ${name}`}
        title={active?.displayPath}
        data-empty={active ? undefined : true}
      >
        {name}
      </Chip>
    </DropdownMenuTrigger>
  );
  return (
    <>
      <DropdownMenu>
        {entry ? (
          <WorkspaceContextMenu entry={entry} onDialog={setDialog}>
            {trigger}
          </WorkspaceContextMenu>
        ) : (
          trigger
        )}
        <WorkspaceMenuContent onChosen={() => navigate("code")} />
      </DropdownMenu>
      <RailDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

function BranchChip() {
  const { active } = useWorkspaces();
  const { git } = useDeckData();
  const { info } = useRuntime();
  const { navigate } = useNavigation();
  if (!active) return null;
  const summary = git.data;
  const changes = summary ? summary.changed + summary.untracked : 0;
  const branch = summary
    ? (summary.branch ?? (summary.head ? `detached ${summary.head.slice(0, 7)}` : "no commits"))
    : !git.loaded
      ? "…"
      : git.failed
        ? "unavailable"
        : "no repository";
  const description = summary
    ? [
        `Branch ${branch}`,
        changes > 0 ? `${changes} uncommitted ${changes === 1 ? "change" : "changes"}` : "working tree clean",
        summary.ahead ? `${summary.ahead} ahead` : null,
        summary.behind ? `${summary.behind} behind` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : git.loaded && !git.failed
      ? `${active.name} isn't a Git repository`
      : "Git status isn't available right now";
  const projectView = viewVisible("folder", info.flags.features);
  return (
    <Tooltip content={description}>
      <Chip
        icon={<GitBranch />}
        caption="Branch"
        tone={summary ? undefined : "muted"}
        aria-label={description}
        onClick={() => navigate(projectView ? "folder" : "code")}
      >
        <span className={styles.branchName}>{branch}</span>
        {changes > 0 ? <span className={styles.delta}>±{changes}</span> : null}
        {summary?.ahead ? (
          <span className={styles.delta}>
            <ArrowUp aria-hidden="true" />
            {summary.ahead}
          </span>
        ) : null}
        {summary?.behind ? (
          <span className={styles.delta}>
            <ArrowDown aria-hidden="true" />
            {summary.behind}
          </span>
        ) : null}
      </Chip>
    </Tooltip>
  );
}

function EnvironmentChip() {
  const { active } = useWorkspaces();
  const { operations } = useDeckData();
  const { navigate } = useNavigation();
  const now = useNow(30_000);
  const environment = primaryEnvironment(operations.data?.environments ?? [], active?.id ?? null);
  const label = environment ? ENVIRONMENT_LABELS[environment.kind] : "Local";
  const tone = environment ? environmentTone(environment) : "muted";
  const description = environment
    ? [
        ENVIRONMENT_LABELS[environment.kind],
        humanize(environment.deploymentStatus),
        `health ${humanize(environment.health).toLowerCase()}`,
        environment.version,
        environment.lastDeploy ? `deployed ${ago(environment.lastDeploy, now)}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "No deployment environment observed for this workspace";
  return (
    <Tooltip content={description}>
      <Chip
        icon={<Globe />}
        caption="Environment"
        tone={tone}
        aria-label={`Environment: ${description}`}
        onClick={() => navigate("operations")}
      >
        <span className={styles.toneDot} data-tone={tone} aria-hidden="true" />
        {label}
      </Chip>
    </Tooltip>
  );
}

function ModeChip() {
  const { settings, setDefaultMode } = usePermissions();
  const { navigate } = useNavigation();
  const mode: PermissionMode | null = settings?.defaultMode ?? null;
  const openSettings = () => {
    navigate("settings");
    requestAnimationFrame(() => requestAnimationFrame(() => focusSection("permissions")));
  };
  return (
    <DropdownMenu>
      <Tooltip content={mode ? MODE_DESCRIPTIONS[mode] : "Loading the permission mode"}>
        <DropdownMenuTrigger asChild>
          <Chip
            icon={<ShieldCheck />}
            caption="Mode"
            menu
            disabled={mode === null}
            aria-label={`Permission mode: ${mode ? MODE_LABELS[mode] : "loading"}`}
          >
            {mode ? MODE_LABELS[mode] : "…"}
          </Chip>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" minWidth={22}>
        <DropdownMenuLabel>New agents start in</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={mode ?? ""}
          onValueChange={(next) => void setDefaultMode(next as PermissionMode, { confirmed: next === "bypass" })}
        >
          {DEFAULT_MODE_CHOICES.map((value) => (
            <DropdownMenuRadioItem key={value} value={value} description={MODE_DESCRIPTIONS[value]}>
              {MODE_LABELS[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<Settings2 />} onSelect={openSettings}>
          Permission settings…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---- Signals ----

function Signals() {
  const { state } = useCodingAgents();
  const { pending, setPanelOpen } = usePermissions();
  const { navigate } = useNavigation();
  const { revealAgents } = useDeckUi();
  const now = useNow(30_000);
  const sections = useMemo(() => (state.status === "ready" ? agentSections(state.data, now) : null), [state, now]);
  const working = sections?.working.length ?? 0;
  const needs = sections ? needsYouCount(sections.needsYou, pending) : pending.length;
  return (
    <div className={styles.signals}>
      <button
        type="button"
        className={styles.signal}
        data-tone={working > 0 ? "working" : "muted"}
        onClick={revealAgents}
        aria-label={working === 1 ? "1 agent working. Show agents" : `${working} agents working. Show agents`}
      >
        <span className={styles.signalDot} data-pulse={working > 0 || undefined} aria-hidden="true" />
        <span className={styles.signalCount}>{working}</span>
        <span className={styles.signalLabel}>working</span>
      </button>
      <button
        type="button"
        className={styles.signal}
        data-tone={needs > 0 ? "waiting" : "muted"}
        onClick={() => {
          const target = needsChipTarget(needs, pending.length);
          if (target === "approvals") setPanelOpen(true);
          else if (target === "agents") revealAgents();
          else navigate("dashboard");
        }}
        aria-label={needs === 1 ? "1 thing needs you" : `${needs} things need you`}
      >
        <span className={styles.signalDot} aria-hidden="true" />
        <span className={styles.signalCount}>{needs}</span>
        <span className={styles.signalLabel}>{needs === 1 ? "needs you" : "need you"}</span>
      </button>
    </div>
  );
}
