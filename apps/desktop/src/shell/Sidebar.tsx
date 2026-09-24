import type { SurfaceId } from "@kalcode/protocol";
import { IconButton, Tooltip } from "@kalcode/ui/components";
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { Mark, Wordmark } from "./Brand.tsx";
import { PRIMARY_ORDER, SURFACES, useNavigation } from "./navigation.tsx";
import styles from "./Sidebar.module.css";
import { MOD_LABEL } from "./shortcuts.ts";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.tsx";

interface SidebarProps {
  collapsed: boolean;
  onOpenPalette: () => void;
}

export function Sidebar({ collapsed, onOpenPalette }: SidebarProps) {
  const { info, updateSettings } = useRuntime();
  const flags = new Map(info.flags.surfaces.map((flag) => [flag.id, flag]));
  const visible = (id: SurfaceId) => flags.get(id)?.visible ?? false;

  const available = PRIMARY_ORDER.filter((id) => visible(id) && flags.get(id)?.state !== "gated");
  const inDevelopment = PRIMARY_ORDER.filter((id) => visible(id) && flags.get(id)?.state === "gated");

  const toggle = () => void updateSettings({ sidebarCollapsed: !collapsed });

  return (
    <nav className={styles.sidebar} aria-label="Primary" data-collapsed={collapsed || undefined}>
      <div className={styles.brand}>
        <Mark size={22} />
        {collapsed ? null : <Wordmark className={styles.wordmark} />}
      </div>

      <div className={styles.workspace}>
        <WorkspaceSwitcher collapsed={collapsed} />
      </div>

      <div className={styles.search}>
        <SidebarButton
          collapsed={collapsed}
          label="Search"
          hint={`${MOD_LABEL} K`}
          icon={<Search />}
          onClick={onOpenPalette}
          className={styles.searchButton}
        />
      </div>

      <ul className={styles.list}>
        {available.map((id) => (
          <NavItem key={id} id={id} collapsed={collapsed} />
        ))}
      </ul>

      {inDevelopment.length > 0 ? (
        <div className={styles.group}>
          {collapsed ? (
            <hr className={styles.divider} />
          ) : (
            <p className={styles.groupLabel} id="nav-in-development">
              In development
            </p>
          )}
          <ul className={styles.list} aria-labelledby={collapsed ? undefined : "nav-in-development"}>
            {inDevelopment.map((id) => (
              <NavItem key={id} id={id} collapsed={collapsed} gated />
            ))}
          </ul>
        </div>
      ) : null}

      <div className={styles.footer}>
        <ul className={styles.list}>{visible("settings") ? <NavItem id="settings" collapsed={collapsed} /> : null}</ul>
        <div className={styles.footerRow}>
          {collapsed ? null : (
            <p className={styles.build}>
              {info.channel === "stable"
                ? `Version ${info.version}`
                : `${capitalize(info.channel)} build ${info.version}`}
            </p>
          )}
          <Tooltip content={`${collapsed ? "Expand" : "Collapse"} sidebar (${MOD_LABEL} B)`} side="right">
            <IconButton
              size="sm"
              label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              icon={collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              onClick={toggle}
            />
          </Tooltip>
        </div>
      </div>
    </nav>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function NavItem({ id, collapsed, gated = false }: { id: SurfaceId; collapsed: boolean; gated?: boolean }) {
  const { current, navigate } = useNavigation();
  const meta = SURFACES[id];
  const Icon = meta.icon;
  const active = current === id;
  return (
    <li>
      <SidebarButton
        collapsed={collapsed}
        label={meta.label}
        icon={<Icon />}
        onClick={() => navigate(id)}
        aria-current={active ? "page" : undefined}
        className={[styles.item, gated && styles.gated].filter(Boolean).join(" ")}
      />
    </li>
  );
}

interface SidebarButtonProps {
  collapsed: boolean;
  label: string;
  icon: React.ReactNode;
  hint?: string;
  onClick: () => void;
  className?: string;
  "aria-current"?: "page";
}

function SidebarButton({ collapsed, label, icon, hint, onClick, className, ...aria }: SidebarButtonProps) {
  const button = (
    <button
      type="button"
      className={[styles.button, className].filter(Boolean).join(" ")}
      onClick={onClick}
      aria-label={collapsed ? label : undefined}
      {...aria}
    >
      <span className={styles.icon} aria-hidden="true">
        {icon}
      </span>
      {collapsed ? null : (
        <>
          <span className={styles.label}>{label}</span>
          {hint ? <kbd className={styles.hint}>{hint}</kbd> : null}
        </>
      )}
    </button>
  );
  return collapsed ? (
    <Tooltip content={hint ? `${label} (${hint})` : label} side="right">
      {button}
    </Tooltip>
  ) : (
    button
  );
}
