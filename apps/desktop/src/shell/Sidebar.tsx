import type { SurfaceId } from "@kalcode/protocol";
import { IconButton, Tooltip } from "@kalcode/ui/components";
import {
  Bell,
  BellDot,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { usePermissions } from "../surfaces/permissions/PermissionsProvider.tsx";
import { Mark, Wordmark } from "./Brand.tsx";
import { PRIMARY_ORDER, SURFACES, useNavigation } from "./navigation.tsx";
import { useNotifications } from "./notifications/NotificationsProvider.tsx";
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
        <BypassNotice collapsed={collapsed} />
        <ul className={styles.list}>
          <ApprovalsItem collapsed={collapsed} />
          <NotificationsItem collapsed={collapsed} />
          {visible("settings") ? <NavItem id="settings" collapsed={collapsed} /> : null}
        </ul>
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

/** Z4: the global pending-approvals indicator. Opens the approvals panel. */
function ApprovalsItem({ collapsed }: { collapsed: boolean }) {
  const { pending, setPanelOpen } = usePermissions();
  const count = pending.length;
  return (
    <li>
      <SidebarButton
        collapsed={collapsed}
        label="Approvals"
        accessibleLabel={count === 0 ? "Approvals, none waiting" : `Approvals, ${count} waiting`}
        icon={count > 0 ? <ShieldAlert /> : <ShieldCheck />}
        onClick={() => setPanelOpen(true)}
        className={[styles.item, count > 0 && styles.approvalsWaiting].filter(Boolean).join(" ")}
        badge={
          count > 0 ? (
            <span className={styles.countBadge} aria-hidden="true">
              {count > 99 ? "99+" : count}
            </span>
          ) : null
        }
      />
    </li>
  );
}

/** Z7-W3: the notification center and its unread count. */
function NotificationsItem({ collapsed }: { collapsed: boolean }) {
  const { unreadCount, setPanelOpen } = useNotifications();
  return (
    <li>
      <SidebarButton
        collapsed={collapsed}
        label="Notifications"
        accessibleLabel={unreadCount === 0 ? "Notifications, none unread" : `Notifications, ${unreadCount} unread`}
        icon={unreadCount > 0 ? <BellDot /> : <Bell />}
        onClick={() => setPanelOpen(true)}
        className={styles.item}
        badge={
          unreadCount > 0 ? (
            <span className={styles.countBadge} aria-hidden="true">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          ) : null
        }
      />
    </li>
  );
}

/** Z4: persistent indicator while Bypass is the default for new threads. */
function BypassNotice({ collapsed }: { collapsed: boolean }) {
  const { settings } = usePermissions();
  const { navigate } = useNavigation();
  if (settings?.defaultMode !== "bypass") return null;
  return (
    <SidebarButton
      collapsed={collapsed}
      label="Bypass is on"
      accessibleLabel="Bypass is on for new threads. Open permission settings"
      icon={<TriangleAlert />}
      onClick={() => navigate("settings")}
      className={styles.bypassNotice}
    />
  );
}

interface SidebarButtonProps {
  collapsed: boolean;
  label: string;
  /** Overrides the accessible name (e.g. to include a count). */
  accessibleLabel?: string;
  /** Shown after the label (and as a dot when collapsed). */
  badge?: React.ReactNode;
  icon: React.ReactNode;
  hint?: string;
  onClick: () => void;
  className?: string;
  "aria-current"?: "page";
}

function SidebarButton({
  collapsed,
  label,
  accessibleLabel,
  badge,
  icon,
  hint,
  onClick,
  className,
  ...aria
}: SidebarButtonProps) {
  const button = (
    <button
      type="button"
      className={[styles.button, className].filter(Boolean).join(" ")}
      onClick={onClick}
      aria-label={accessibleLabel ?? (collapsed ? label : undefined)}
      {...aria}
    >
      <span className={styles.icon} aria-hidden="true">
        {icon}
      </span>
      {collapsed ? (
        badge ? (
          <span className={styles.badgeDot} aria-hidden="true" />
        ) : null
      ) : (
        <>
          <span className={styles.label}>{label}</span>
          {hint ? <kbd className={styles.hint}>{hint}</kbd> : null}
          {badge}
        </>
      )}
    </button>
  );
  return collapsed ? (
    <Tooltip content={hint ? `${label} (${hint})` : (accessibleLabel ?? label)} side="right">
      {button}
    </Tooltip>
  ) : (
    button
  );
}
