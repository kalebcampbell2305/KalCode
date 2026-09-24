import type { ShellOption, TerminalInfo } from "@kalcode/protocol";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  IconButton,
  Tooltip,
} from "@kalcode/ui/components";
import { ChevronDown, Plus, SquareTerminal, X } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import { describeTerminalStatus } from "../../runtime/workspaceState.ts";
import styles from "./Code.module.css";
import { CODE_SHORTCUT_LABELS } from "./shortcuts.ts";

export const tabId = (terminalId: string) => `terminal-tab-${terminalId}`;
export const panelId = (terminalId: string) => `terminal-panel-${terminalId}`;

interface TerminalTabsProps {
  terminals: readonly TerminalInfo[];
  labels: ReadonlyMap<string, string>;
  activeId: string | null;
  shells: readonly ShellOption[];
  disabled: boolean;
  /** Selects a tab; `focusTerminal` moves keyboard focus into its terminal. */
  onSelect: (terminalId: string, focusTerminal: boolean) => void;
  onClose: (terminalId: string) => void;
  onNew: (shellId: string | null) => void;
}

function statusTone(terminal: TerminalInfo): "live" | "idle" | "danger" {
  if (terminal.status === "running") return "live";
  if (terminal.status === "exited" && terminal.exitCode !== 0 && terminal.exitCode !== null) return "danger";
  return "idle";
}

/**
 * Terminal tabs (WAI-ARIA tabs with automatic activation): arrow keys, Home and End move between
 * tabs, Enter moves focus into the terminal, Delete closes the tab. The close control is a mouse
 * affordance; keyboard users close with Delete or Ctrl+Shift+W.
 */
export function TerminalTabs({
  terminals,
  labels,
  activeId,
  shells,
  disabled,
  onSelect,
  onClose,
  onNew,
}: TerminalTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const chose = useRef(false);
  const defaultShell = shells.find((s) => s.isDefault) ?? shells[0];

  const focusTab = (id: string) => {
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(id))}`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = terminals.findIndex((t) => t.id === activeId);
    const move = (next: number) => {
      const target = terminals[(next + terminals.length) % terminals.length];
      if (!target) return;
      event.preventDefault();
      onSelect(target.id, false);
      focusTab(target.id);
    };
    switch (event.key) {
      case "ArrowRight":
        move(index + 1);
        break;
      case "ArrowLeft":
        move(index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(terminals.length - 1);
        break;
      case "Enter":
      case " ":
        if (activeId) {
          event.preventDefault();
          onSelect(activeId, true);
        }
        break;
      case "Delete":
        if (activeId) {
          event.preventDefault();
          onClose(activeId);
        }
        break;
    }
  };

  return (
    <div className={styles.tabBar}>
      <div
        ref={listRef}
        role="tablist"
        aria-label="Terminals"
        className={styles.tablist}
        onKeyDown={onKeyDown}
        data-empty={terminals.length === 0 || undefined}
      >
        {terminals.map((terminal) => {
          const selected = terminal.id === activeId;
          const label = labels.get(terminal.id) ?? terminal.title;
          const status = describeTerminalStatus(terminal);
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the tablist handles keys for every tab (roving focus).
            <div
              key={terminal.id}
              id={tabId(terminal.id)}
              role="tab"
              tabIndex={selected ? 0 : -1}
              aria-selected={selected}
              aria-controls={panelId(terminal.id)}
              className={styles.tab}
              data-status={terminal.status}
              title={`${label} — ${status}`}
              onClick={() => onSelect(terminal.id, true)}
              onMouseDown={(event) => {
                // Middle click closes, like browser tabs.
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(terminal.id);
                }
              }}
            >
              <span className={styles.tabDot} data-tone={statusTone(terminal)} aria-hidden="true" />
              <span className={styles.tabLabel}>{label}</span>
              {terminal.status === "running" ? null : <span className={styles.tabState}>Ended</span>}
              {/* Mouse affordance; keyboard users close with Delete or Ctrl+Shift+W. */}
              <span
                className={styles.tabClose}
                aria-hidden="true"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(terminal.id);
                }}
              >
                <X />
              </span>
            </div>
          );
        })}
      </div>
      <div className={styles.tabActions}>
        <Tooltip content={`New ${defaultShell?.name ?? "terminal"} terminal (${CODE_SHORTCUT_LABELS["new-terminal"]})`}>
          <IconButton
            size="sm"
            label="New terminal"
            icon={<Plus />}
            disabled={disabled || shells.length === 0}
            onClick={() => onNew(null)}
          />
        </Tooltip>
        <DropdownMenu>
          <Tooltip content="Choose a shell">
            <DropdownMenuTrigger asChild>
              <IconButton
                size="sm"
                label="Choose a shell"
                icon={<ChevronDown />}
                disabled={disabled || shells.length === 0}
              />
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent
            align="end"
            minWidth={14}
            // A chosen shell opens a terminal that takes focus; don't pull it back to the trigger.
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
                  onNew(shell.id);
                }}
              >
                {shell.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
