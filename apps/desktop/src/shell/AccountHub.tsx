import type { SurfaceId } from "@kalcode/protocol";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from "@kalcode/ui/components";
import {
  AudioLines,
  ChevronsUpDown,
  CreditCard,
  Gauge,
  Keyboard,
  LogOut,
  Palette,
  PlugZap,
  Settings,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { forwardRef, useRef, useState } from "react";
import { useOptionalAccount } from "../account/AccountProvider.tsx";
import type { AccountPhase, AccountTier, AccountUsageSnapshot } from "../ipc/account.ts";
import { publicVersion } from "../platform/version.ts";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { focusSection } from "../surfaces/dashboard/useNow.ts";
import { TIER_NAMES } from "../surfaces/settings/SettingsAccount.tsx";
import styles from "./AccountHub.module.css";
import { useNavigation } from "./navigation.tsx";
import { MOD_LABEL } from "./shortcuts.ts";

/** Whether the hub shows: a signed-in account is loaded. */
export function useAccountHubShown(): boolean {
  return Boolean(useOptionalAccount()?.snapshot.account);
}

/** Settings sections the hub opens directly (their panel ids on the Settings page). */
export const HUB_SECTIONS = {
  account: "kalcode-account",
  kalvoice: "kalvoice",
  preferences: "permissions",
  appearance: "appearance",
} as const;

const PAID: ReadonlySet<AccountTier> = new Set(["pro", "max", "max2x"]);

/**
 * The name the hub shows: the display name set in Settings → Profile, else the email's local part.
 * Initials come from the first and last word of that name ("Ada Lovelace" → "AL", "ada.l" → "AL").
 */
export function kalcodeIdentity(
  displayName: string | null | undefined,
  email: string,
): {
  name: string;
  initials: string;
} {
  const at = email.lastIndexOf("@");
  const name = displayName?.trim() || (at > 0 ? email.slice(0, at) : email);
  const words = name.split(/[\s._+-]+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const first = (word: string | undefined) => word?.match(/[\p{L}\p{N}]/u)?.[0] ?? "";
  const letters = words.length > 1 ? first(words[0]) + first(words[words.length - 1]) : first(words[0]);
  return { name, initials: (letters || "?").toLocaleUpperCase() };
}

/** "Pro plan", "Owner", "Free plan · Offline"; null while no plan is verified. */
export function planLabel(tier: AccountTier | null, phase: AccountPhase): string | null {
  if (!tier) return null;
  const label = tier === "owner" ? TIER_NAMES.owner : `${TIER_NAMES[tier]} plan`;
  return phase === "offline_grace" ? `${label} · Offline` : label;
}

interface AccountHubProps {
  collapsed: boolean;
  onOpenPalette: () => void;
}

/**
 * Account Hub: the signed-in account at the foot of the sidebar. Opens a compact menu of
 * account, usage, provider, KalVoice, preference and billing shortcuts, Settings and Sign out.
 */
export function AccountHub({ collapsed, onOpenPalette }: AccountHubProps) {
  const account = useOptionalAccount();
  const { info, settings } = useRuntime();
  const { navigate } = useNavigation();
  // A section opened from the menu takes focus; Radix must not move it back to the trigger.
  const focusMoves = useRef(false);
  // The collapsed tooltip stays out of the way while the menu is open.
  const [menuOpen, setMenuOpen] = useState(false);

  const user = account?.snapshot.account;
  if (!account || !user) return null;
  const { snapshot, usage, busy, actions } = account;
  const { name, initials } = kalcodeIdentity(settings.displayName, user.email);
  const plan = planLabel(snapshot.tier, snapshot.phase);
  const paid = snapshot.tier !== null && PAID.has(snapshot.tier);
  const premium = paid || snapshot.tier === "owner";

  const usable = (id: SurfaceId) => {
    const flag = info.flags.surfaces.find((surface) => surface.id === id);
    return Boolean(flag?.visible && flag.state !== "gated");
  };
  const settingsShown = usable("settings");
  // Settings → KalVoice exists only where the KalVoice runtime runs (see Shell).
  const kalvoiceShown = settingsShown && usable("kalvoice");

  const openSection = (section: string) => {
    focusMoves.current = true;
    navigate("settings");
    requestAnimationFrame(() => requestAnimationFrame(() => focusSection(section)));
  };
  const go = (id: SurfaceId) => {
    focusMoves.current = true;
    navigate(id);
    requestAnimationFrame(() => document.getElementById("main")?.focus({ preventScroll: true }));
  };

  const accessibleName = `Account: ${name}${plan ? `, ${plan}` : ""}`;
  const trigger = (
    <DropdownMenuTrigger asChild>
      <HubButton
        collapsed={collapsed}
        name={name}
        initials={initials}
        plan={plan}
        premium={premium}
        label={accessibleName}
      />
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      {collapsed ? (
        <Tooltip content={plan ? `${name} · ${plan}` : name} side="right" hidden={menuOpen}>
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent
        className={styles.menu}
        side={collapsed ? "right" : "top"}
        align={collapsed ? "end" : "start"}
        sideOffset={collapsed ? 10 : 8}
        onCloseAutoFocus={(event) => {
          if (focusMoves.current) event.preventDefault();
          focusMoves.current = false;
        }}
      >
        <div className={styles.header}>
          <Avatar initials={initials} large />
          <div className={styles.identity}>
            <p className={styles.headerName}>{name}</p>
            <p className={styles.headerEmail}>{user.email}</p>
          </div>
          {snapshot.tier ? (
            <span className={styles.planBadge} data-premium={premium || undefined}>
              {TIER_NAMES[snapshot.tier]}
            </span>
          ) : null}
        </div>
        {usage ? <UsageMeter usage={usage} /> : null}

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {settingsShown ? (
            <>
              <DropdownMenuItem icon={<UserRound />} onSelect={() => openSection(HUB_SECTIONS.account)}>
                Account &amp; plan
              </DropdownMenuItem>
              <DropdownMenuItem icon={<Gauge />} onSelect={() => openSection(HUB_SECTIONS.account)}>
                Usage
              </DropdownMenuItem>
            </>
          ) : null}
          {paid || settingsShown ? (
            <DropdownMenuItem
              icon={<CreditCard />}
              disabled={paid && busy}
              onSelect={() => {
                // Paid plans are managed in the billing portal (Settings' "Manage plan"); the
                // account section shows the result and any error. Free and Owner have no billing.
                if (settingsShown) openSection(HUB_SECTIONS.account);
                if (paid) void actions.portal();
              }}
            >
              Billing
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {usable("providers") ? (
            <DropdownMenuItem icon={<PlugZap />} onSelect={() => go("providers")}>
              Connected providers
            </DropdownMenuItem>
          ) : null}
          {kalvoiceShown ? (
            <DropdownMenuItem icon={<AudioLines />} onSelect={() => openSection(HUB_SECTIONS.kalvoice)}>
              KalVoice
            </DropdownMenuItem>
          ) : null}
          {settingsShown ? (
            <>
              <DropdownMenuItem icon={<SlidersHorizontal />} onSelect={() => openSection(HUB_SECTIONS.preferences)}>
                Preferences
              </DropdownMenuItem>
              <DropdownMenuItem icon={<Palette />} onSelect={() => openSection(HUB_SECTIONS.appearance)}>
                Appearance
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem
            icon={<Keyboard />}
            shortcut={`${MOD_LABEL} K`}
            // The command palette lists every command with its shortcut. Open it once the menu
            // has closed, so closing the palette returns focus to the hub.
            onSelect={() => requestAnimationFrame(onOpenPalette)}
          >
            Keyboard shortcuts
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        {settingsShown ? (
          <DropdownMenuItem icon={<Settings />} onSelect={() => go("settings")}>
            Full Settings
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem icon={<LogOut />} tone="danger" disabled={busy} onSelect={() => void actions.logout()}>
          Sign out
        </DropdownMenuItem>
        <p className={styles.caption}>
          {info.channel === "stable"
            ? `KalCode ${publicVersion(info.version)}`
            : `KalCode ${publicVersion(info.version)} · ${info.channel} build`}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Avatar({ initials, large = false }: { initials: string; large?: boolean }) {
  return (
    <span className={[styles.avatar, large && styles.avatarLarge].filter(Boolean).join(" ")} aria-hidden="true">
      {initials}
    </span>
  );
}

/** The real reset moment from the usage snapshot, e.g. "Nov 1, 9:00 AM". */
function formatReset(resetsAt: string): string {
  const date = new Date(resetsAt);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function UsageMeter({ usage }: { usage: AccountUsageSnapshot }) {
  const { used, allowance } = usage;
  const fraction = allowance === null || allowance === 0 ? null : Math.min(1, used / allowance);
  return (
    <div className={styles.usage}>
      <p className={styles.usageText}>
        <span>KalVoice requests</span>
        <span className={styles.usageValue}>
          {allowance === null ? "Unlimited" : `${Math.max(0, allowance - used).toLocaleString()} remaining`}
        </span>
      </p>
      {fraction !== null ? (
        <span className={styles.bar} aria-hidden="true" data-high={fraction >= 0.9 || undefined}>
          <span className={styles.fill} style={{ width: `${Math.max(fraction * 100, used > 0 ? 3 : 0)}%` }} />
        </span>
      ) : null}
      <p className={styles.usageText}>
        <span>
          {allowance === null
            ? `${used.toLocaleString()} used`
            : `${used.toLocaleString()} of ${allowance.toLocaleString()} used`}
        </span>
        <span>Resets {formatReset(usage.resetsAt)}</span>
      </p>
    </div>
  );
}

interface HubButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  collapsed: boolean;
  name: string;
  initials: string;
  plan: string | null;
  premium: boolean;
  label: string;
}

const HubButton = forwardRef<HTMLButtonElement, HubButtonProps>(function HubButton(
  { collapsed, name, initials, plan, premium, label, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={styles.trigger}
      data-collapsed={collapsed || undefined}
      aria-label={label}
      {...rest}
    >
      <Avatar initials={initials} />
      {collapsed ? null : (
        <>
          <span className={styles.text}>
            <span className={styles.name}>{name}</span>
            {plan ? (
              <span className={styles.plan} data-premium={premium || undefined}>
                {plan}
              </span>
            ) : null}
          </span>
          <ChevronsUpDown className={styles.chevron} aria-hidden="true" />
        </>
      )}
    </button>
  );
});
