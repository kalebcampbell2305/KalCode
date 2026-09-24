import type { SettingsPatch, SurfaceId } from "@kalcode/protocol";
import { Command } from "cmdk";
import {
  ArrowRightLeft,
  ClipboardCopy,
  FolderOpen,
  FolderPlus,
  KeyRound,
  MessageSquarePlus,
  Monitor,
  Moon,
  PanelLeft,
  Rows3,
  Search,
  SquareTerminal,
  Sun,
} from "lucide-react";
import type { ReactNode } from "react";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../runtime/WorkspaceProvider.tsx";
import { CODE_SHORTCUT_LABELS } from "../surfaces/code/shortcuts.ts";
import { useDiagnosticsActions } from "../surfaces/settings/useDiagnosticsActions.ts";
import { useThreadsIntent } from "../surfaces/threads/intent.tsx";
import styles from "./CommandPalette.module.css";
import { PRIMARY_ORDER, SURFACES, useNavigation } from "./navigation.tsx";
import { MOD_LABEL } from "./shortcuts.ts";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const { info, settings, updateSettings } = useRuntime();
  const { navigate } = useNavigation();
  const diagnostics = useDiagnosticsActions();
  const workspaces = useWorkspaces();
  const threadsIntent = useThreadsIntent();

  const run = (action: () => unknown) => () => {
    onOpenChange(false);
    void action();
  };
  const set = (patch: SettingsPatch) => run(() => updateSettings(patch));

  const visible = new Set(info.flags.surfaces.filter((f) => f.visible).map((f) => f.id));
  const destinations = [...PRIMARY_ORDER, "settings" as const].filter((id): id is SurfaceId => visible.has(id));

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      overlayClassName={styles.overlay}
      contentClassName={styles.content}
      className={styles.command}
      loop
    >
      <Command.Input className={styles.input} placeholder="Search commands and destinations" />
      <Command.List className={styles.list}>
        <Command.Empty className={styles.empty}>No matching commands.</Command.Empty>

        {visible.has("threads") ? (
          <Command.Group heading="Threads" className={styles.group}>
            <Item
              icon={<MessageSquarePlus />}
              onSelect={run(() => {
                navigate("threads");
                threadsIntent.request("new");
              })}
            >
              New thread
            </Item>
            <Item
              icon={<Search />}
              onSelect={run(() => {
                navigate("threads");
                threadsIntent.request("search");
              })}
            >
              Search threads
            </Item>
          </Command.Group>
        ) : null}

        <Command.Group heading="Go to" className={styles.group}>
          {destinations.map((id) => {
            const meta = SURFACES[id];
            const Icon = meta.icon;
            return (
              <Item key={id} icon={<Icon />} onSelect={run(() => navigate(id))} keywords={[meta.summary]}>
                {meta.label}
              </Item>
            );
          })}
        </Command.Group>

        <Command.Group heading="Code" className={styles.group}>
          {workspaces.active?.available ? (
            <Item
              icon={<SquareTerminal />}
              onSelect={run(() => {
                navigate("code");
                return workspaces.createTerminal(null);
              })}
              shortcut={CODE_SHORTCUT_LABELS["new-terminal"]}
              keywords={["shell", "console", "command line", workspaces.active.name]}
            >
              New terminal
            </Item>
          ) : null}
          <Item
            icon={<FolderPlus />}
            onSelect={run(async () => {
              const opened = await workspaces.openFolder();
              if (opened) navigate("code");
            })}
            keywords={["workspace", "project", "folder"]}
          >
            Open folder…
          </Item>
          {workspaces.workspaces
            .filter((w) => w.id !== workspaces.active?.id && w.available)
            .map((workspace) => (
              <Item
                key={workspace.id}
                icon={<ArrowRightLeft />}
                onSelect={run(async () => {
                  if (await workspaces.activate(workspace.id)) navigate("code");
                })}
                keywords={["switch workspace", workspace.displayPath]}
              >
                {`Switch to ${workspace.name}`}
              </Item>
            ))}
        </Command.Group>

        <Command.Group heading="Appearance" className={styles.group}>
          <Item icon={<Monitor />} onSelect={set({ theme: "system" })} current={settings.theme === "system"}>
            Use system theme
          </Item>
          <Item icon={<Sun />} onSelect={set({ theme: "light" })} current={settings.theme === "light"}>
            Use light theme
          </Item>
          <Item icon={<Moon />} onSelect={set({ theme: "dark" })} current={settings.theme === "dark"}>
            Use dark theme
          </Item>
          <Item
            icon={<Rows3 />}
            onSelect={set({ density: settings.density === "compact" ? "comfortable" : "compact" })}
          >
            {settings.density === "compact" ? "Use comfortable density" : "Use compact density"}
          </Item>
          <Item
            icon={<PanelLeft />}
            onSelect={set({ sidebarCollapsed: !settings.sidebarCollapsed })}
            shortcut={`${MOD_LABEL} B`}
          >
            {settings.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          </Item>
        </Command.Group>

        <Command.Group heading="Diagnostics" className={styles.group}>
          <Item icon={<ClipboardCopy />} onSelect={run(diagnostics.copyReport)}>
            Copy diagnostic report
          </Item>
          <Item icon={<FolderOpen />} onSelect={run(diagnostics.openLogs)}>
            Open logs folder
          </Item>
          <Item icon={<KeyRound />} onSelect={run(diagnostics.checkSecureStore)}>
            Check credential store
          </Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}

interface ItemProps {
  icon: ReactNode;
  children: string;
  onSelect: () => void;
  keywords?: string[];
  shortcut?: string;
  current?: boolean;
}

function Item({ icon, children, onSelect, keywords, shortcut, current }: ItemProps) {
  return (
    <Command.Item className={styles.item} onSelect={onSelect} value={children} {...(keywords ? { keywords } : {})}>
      <span className={styles.itemIcon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.itemLabel}>{children}</span>
      {current ? <span className={styles.current}>Current</span> : null}
      {shortcut ? <kbd>{shortcut}</kbd> : null}
    </Command.Item>
  );
}
