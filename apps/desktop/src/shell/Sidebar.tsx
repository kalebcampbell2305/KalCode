import type { SurfaceId } from "@kalcode/protocol";
import { IconButton, Tooltip } from "@kalcode/ui/components";
import { Bell, BellDot, Globe, PanelLeftClose, PanelLeftOpen, ShieldAlert, ShieldCheck } from "lucide-react";
import { useId } from "react";
import { publicVersion } from "../platform/version.ts";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { DashboardDataBoundary, useWaitingForYouCount } from "../surfaces/dashboard/data/DashboardData.tsx";
import { usePermissions } from "../surfaces/permissions/PermissionsProvider.tsx";
import { AccountHub, useAccountHubShown } from "./AccountHub.tsx";
import { ProjectList } from "./deck/ProjectList.tsx";
import { type Destination, destinationMeta, PRIMARY_ORDER, useNavigation, viewVisible } from "./navigation.tsx";
import { useNotifications } from "./notifications/NotificationsProvider.tsx";
import { useRail } from "./rail/RailProvider.tsx";
import styles from "./Sidebar.module.css";
import { MOD_LABEL } from "./shortcuts.ts";
import { useOpenBrowser } from "./useOpenBrowser.ts";

interface SidebarProps {
  collapsed: boolean;
  onOpenPalette: () => void;
}

export function Sidebar({ collapsed, onOpenPalette }: SidebarProps) {
  const openBrowser = useOpenBrowser();
  const { info, updateSettings } = useRuntime();
  const rail = useRail();
  const flags = new Map(info.flags.surfaces.map((flag) => [flag.id, flag]));
  const visible = (id: SurfaceId) => flags.get(id)?.visible ?? false;

  const available = PRIMARY_ORDER.filter((id) => visible(id) && flags.get(id)?.state !== "gated");
  const inDevelopment = PRIMARY_ORDER.filter((id) => visible(id) && flags.get(id)?.state === "gated");

  const toggle = () => void updateSettings({ sidebarCollapsed: !collapsed });
  // The hub menu carries the build version; without an account loaded the footer shows it.
  const hubShown = useAccountHubShown();

  return (
    <nav className={styles.sidebar} aria-label="Primary" data-collapsed={collapsed || undefined}>
      {/* Command Deck: the brand, workspace and search live in the top bar. */}
      <ul className={styles.list}>
        {viewVisible("home", info.flags.features) ? <NavItem id="home" collapsed={collapsed} /> : null}
        {available.map((id) =>
          id === "dashboard" ? (
            <DashboardNavItem key={id} collapsed={collapsed} />
          ) : (
            <NavItem key={id} id={id} collapsed={collapsed} />
          ),
        )}
        {available.includes("code") ? (
          <li>
            <SidebarButton
              collapsed={collapsed}
              label="Browser"
              accessibleLabel="Open Browser"
              icon={<Globe />}
              onClick={() => void openBrowser()}
              className={styles.item}
            />
          </li>
        ) : null}
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

      {/* The workspace rail, when the build has it, is the projects list instead. */}
      {rail.enabled ? null : <ProjectList collapsed={collapsed} />}

      <div className={styles.footer}>
        <ul className={styles.list}>
          <ApprovalsItem collapsed={collapsed} />
          <NotificationsItem collapsed={collapsed} />
          {visible("settings") ? <NavItem id="settings" collapsed={collapsed} /> : null}
        </ul>
        <div className={styles.footerRow}>
          <AccountHub collapsed={collapsed} onOpenPalette={onOpenPalette} />
          {hubShown || collapsed ? null : (
            <p className={styles.build}>
              {info.channel === "stable"
                ? `Version ${publicVersion(info.version)}`
                : `${capitalize(info.channel)} build ${publicVersion(info.version)}`}
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

interface NavItemProps {
  id: Destination;
  collapsed: boolean;
  gated?: boolean;
  /** A count shown after the label (hidden at zero), and its words for assistive technology. */
  count?: { value: number; description: string };
}

function NavItem({ id, collapsed, gated = false, count }: NavItemProps) {
  const { current, navigate } = useNavigation();
  const meta = destinationMeta(id);
  const Icon = meta.icon;
  const active = current === id;
  const shown = count && count.value > 0 ? count : null;
  return (
    <li>
      <SidebarButton
        collapsed={collapsed}
        label={meta.label}
        icon={<Icon />}
        onClick={() => navigate(id)}
        aria-current={active ? "page" : undefined}
        className={[styles.item, gated && styles.gated].filter(Boolean).join(" ")}
        description={shown?.description}
        badge={
          shown ? (
            <span className={styles.countBadge} aria-hidden="true">
              {shown.value > 99 ? "99+" : shown.value}
            </span>
          ) : null
        }
      />
    </li>
  );
}

/**
 * The Dashboard entry with a "needs you" count: the Dashboard's "Waiting for you" chip, from the
 * same thread list (its data provider, or one of its own outside the Dashboard). Hidden at zero.
 */
function DashboardNavItem({ collapsed }: { collapsed: boolean }) {
  return (
    <DashboardDataBoundary>
      <DashboardNavItemCount collapsed={collapsed} />
    </DashboardDataBoundary>
  );
}

function DashboardNavItemCount({ collapsed }: { collapsed: boolean }) {
  const waiting = useWaitingForYouCount();
  return (
    <NavItem
      id="dashboard"
      collapsed={collapsed}
      count={{ value: waiting, description: `${waiting} ${waiting === 1 ? "session needs" : "sessions need"} you` }}
    />
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

interface SidebarButtonProps {
  collapsed: boolean;
  label: string;
  /** Overrides the accessible name (e.g. to include a count). */
  accessibleLabel?: string;
  /** Shown after the label (and as a dot when collapsed). */
  badge?: React.ReactNode;
  /** Extra words for assistive technology (`aria-describedby`); the accessible name is unchanged. */
  description?: string;
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
  description,
  icon,
  hint,
  onClick,
  className,
  ...aria
}: SidebarButtonProps) {
  const descriptionId = useId();
  const button = (
    <button
      type="button"
      className={[styles.button, className].filter(Boolean).join(" ")}
      onClick={onClick}
      aria-label={accessibleLabel ?? (collapsed ? label : undefined)}
      aria-describedby={description ? descriptionId : undefined}
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
  const withTooltip = collapsed ? (
    <Tooltip
      content={hint ? `${label} (${hint})` : description ? `${label}: ${description}` : (accessibleLabel ?? label)}
      side="right"
    >
      {button}
    </Tooltip>
  ) : (
    button
  );
  return description ? (
    <>
      {withTooltip}
      <span id={descriptionId} className="visually-hidden">
        {description}
      </span>
    </>
  ) : (
    withTooltip
  );
}
