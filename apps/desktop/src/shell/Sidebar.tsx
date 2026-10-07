import type { SurfaceId } from "@kalcode/protocol";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Tooltip,
} from "@kalcode/ui/components";
import { Bell, BellDot, Globe, LayoutGrid, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useId } from "react";
import { publicVersion } from "../platform/version.ts";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { DashboardDataBoundary } from "../surfaces/dashboard/data/DashboardData.tsx";
import { AccountHub, useAccountHubShown } from "./AccountHub.tsx";
import { useAttention } from "./attention/useAttention.ts";
import { ProjectList } from "./deck/ProjectList.tsx";
import {
  type Destination,
  destinationMeta,
  PRIMARY_NAV,
  PRIMARY_ORDER,
  useNavigation,
  viewVisible,
} from "./navigation.tsx";
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
  const { info, updateSettings } = useRuntime();
  const rail = useRail();
  const flags = new Map(info.flags.surfaces.map((flag) => [flag.id, flag]));
  const visible = (id: SurfaceId) => flags.get(id)?.visible ?? false;

  // Projects, Code and Activity are where people work. Every other surface stays one click away
  // in More (and in the command palette): fewer decisions in the rail, no capability lost.
  const primary = PRIMARY_NAV.filter((id) => visible(id) && flags.get(id)?.state !== "gated");
  const more = PRIMARY_ORDER.filter((id) => !PRIMARY_NAV.includes(id) && visible(id));
  const gated = new Set(more.filter((id) => flags.get(id)?.state === "gated"));

  const toggle = () => void updateSettings({ sidebarCollapsed: !collapsed });
  // The hub menu carries the build version; without an account loaded the footer shows it.
  const hubShown = useAccountHubShown();

  return (
    <nav className={styles.sidebar} aria-label="Primary" data-collapsed={collapsed || undefined}>
      {/* Decoration as inert elements, not pseudo-elements on the nav (see Sidebar.module.css). */}
      <div className={styles.stars} aria-hidden="true" />
      {/* Command Deck: the brand, workspace and search live in the top bar. */}
      <ul className={styles.list}>
        {viewVisible("home", info.flags.features) ? <NavItem id="home" collapsed={collapsed} /> : null}
        {primary.map((id) => (
          <NavItem key={id} id={id} collapsed={collapsed} />
        ))}
      </ul>

      {/* The workspace rail, when the build has it, is the projects list instead. */}
      {rail.enabled ? null : <ProjectList collapsed={collapsed} />}

      <div className={styles.footer}>
        <ul className={styles.list}>
          <NeedsYouItem collapsed={collapsed} />
          <MoreItem collapsed={collapsed} surfaces={more} gated={gated} withBrowser={primary.includes("code")} />
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
      <div className={styles.edgeGlow} aria-hidden="true" />
    </nav>
  );
}

/**
 * More: every other place (Browser, Runs, Threads, KalVoice, Unified Memory, Providers and, in
 * development builds, what is still being built). Progressive disclosure: expert surfaces stay one
 * click away here, in the command palette and from the actions that lead to them.
 */
function MoreItem({
  collapsed,
  surfaces,
  gated,
  withBrowser,
}: {
  collapsed: boolean;
  surfaces: readonly SurfaceId[];
  gated: ReadonlySet<SurfaceId>;
  withBrowser: boolean;
}) {
  const { current, navigate } = useNavigation();
  const openBrowser = useOpenBrowser();
  if (surfaces.length === 0 && !withBrowser) return null;
  const showing = surfaces.includes(current as SurfaceId) ? destinationMeta(current).label : null;
  const label = showing ? `More · ${showing}` : "More";
  const item = (id: SurfaceId) => {
    const meta = destinationMeta(id);
    const Icon = meta.icon;
    return (
      <DropdownMenuItem key={id} icon={<Icon />} onSelect={() => navigate(id)}>
        {meta.label}
      </DropdownMenuItem>
    );
  };
  const trigger = (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        className={[styles.button, styles.item].join(" ")}
        aria-label={showing ? `More places, showing ${showing}` : "More places"}
        aria-current={showing ? "page" : undefined}
      >
        {/* The current page's bar on an inert element, not ::before (see Sidebar.module.css). */}
        {showing ? <span className={styles.currentBar} aria-hidden="true" /> : null}
        <span className={styles.icon} aria-hidden="true">
          <LayoutGrid />
        </span>
        {collapsed ? null : <span className={styles.label}>{label}</span>}
      </button>
    </DropdownMenuTrigger>
  );
  return (
    <li>
      <DropdownMenu>
        {collapsed ? (
          <Tooltip content={label} side="right">
            {trigger}
          </Tooltip>
        ) : (
          trigger
        )}
        <DropdownMenuContent side="right" align="end" sideOffset={8}>
          {withBrowser ? (
            <DropdownMenuItem icon={<Globe />} onSelect={() => void openBrowser()}>
              Browser
            </DropdownMenuItem>
          ) : null}
          {surfaces.filter((id) => !gated.has(id)).map(item)}
          {gated.size > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>In development</DropdownMenuLabel>
              {surfaces.filter((id) => gated.has(id)).map(item)}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
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
 * Needs You: the one attention inbox (questions, approvals, failures, sign-outs, stalled agents and
 * finished work to review). The count is only what genuinely needs the person; zero shows no badge.
 */
function NeedsYouItem({ collapsed }: { collapsed: boolean }) {
  return (
    <DashboardDataBoundary>
      <NeedsYouButton collapsed={collapsed} />
    </DashboardDataBoundary>
  );
}

function NeedsYouButton({ collapsed }: { collapsed: boolean }) {
  const { setPanelOpen } = useNotifications();
  const { items } = useAttention();
  const count = items.length;
  // Blocked work (a question, an approval, a failure, a sign-out) is lit; review and stalled aren't.
  const urgent = items.some((item) => item.kind !== "review" && item.kind !== "stalled");
  return (
    <li>
      <SidebarButton
        collapsed={collapsed}
        label="Needs you"
        accessibleLabel={count === 0 ? "Needs you, nothing waiting" : `Needs you, ${count} waiting`}
        icon={count > 0 ? <BellDot /> : <Bell />}
        onClick={() => setPanelOpen(true)}
        className={[styles.item, urgent && styles.approvalsWaiting].filter(Boolean).join(" ")}
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
      {aria["aria-current"] === "page" ? <span className={styles.currentBar} aria-hidden="true" /> : null}
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
