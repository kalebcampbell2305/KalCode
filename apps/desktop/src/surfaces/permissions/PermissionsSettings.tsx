import type { PermissionMode, PermissionProfile } from "@kalcode/protocol";
import { Button, Panel, SegmentedControl } from "@kalcode/ui/components";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import {
  EFFECT_LABELS,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  DEFAULT_MODE_CHOICES as MODES,
  SCOPE_LABELS,
  startModeFor,
} from "./labels.ts";
import { usePermissions } from "./PermissionsProvider.tsx";
import styles from "./PermissionsSettings.module.css";

/**
 * Settings → Permissions: default mode for new coding agents and threads, and profiles.
 *
 * KalCode runs without approvals (owner directive 2026-10-03): new agents start in Bypass unless
 * the saved default is read-only Plan, and Bypass needs no confirmation.
 */
export function PermissionsSettings() {
  const { settings, profiles, setDefaultMode } = usePermissions();
  const customProfiles = profiles.filter((profile) => profile.mode === "custom");
  const mode = settings?.defaultMode ?? "bypass";
  const startable = startModeFor(mode) === mode;
  const fallbackMode = startModeFor(mode);

  const choose = (next: PermissionMode) => {
    const profileId = next === "custom" ? (settings?.defaultProfileId ?? customProfiles[0]?.id ?? null) : null;
    void setDefaultMode(next, { profileId, confirmed: next === "bypass" });
  };

  return (
    <Panel
      id="permissions"
      title="Permissions"
      icon={<ShieldCheck />}
      description="Coding agents run without approval prompts. Only access to credentials and secrets still asks."
      padding="none"
      bodyClassName={styles.body}
      className={styles.panel}
    >
      {settings && !startable && !MODES.includes(mode) ? (
        <div className={styles.defaultNote} role="status">
          {/* The rail on an inert element, not ::before (see PermissionsSettings.module.css). */}
          <span className={styles.defaultNoteRail} aria-hidden="true" />
          <TriangleAlert aria-hidden="true" />
          <div>
            <p className={styles.bannerTitle}>{MODE_LABELS[mode]} is your saved default</p>
            <p className={styles.bannerText}>
              KalCode runs coding agents without approval prompts, so new agents start in {MODE_LABELS[fallbackMode]}.
            </p>
          </div>
          <Button size="sm" onClick={() => void setDefaultMode(fallbackMode)}>
            Use {MODE_LABELS[fallbackMode]}
          </Button>
        </div>
      ) : null}

      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.rowText}>
            <p id="default-mode-label" className={styles.rowLabel}>
              Default mode for new coding agents
            </p>
            <p id="default-mode-help" className={styles.rowHelp}>
              {startable ? MODE_DESCRIPTIONS[mode] : `New coding agents start in ${MODE_LABELS[fallbackMode]}.`}
            </p>
          </div>
          <SegmentedControl<PermissionMode>
            aria-labelledby="default-mode-label"
            value={mode}
            onValueChange={choose}
            disabled={settings === null}
            options={MODES.map((value) => ({ value, label: MODE_LABELS[value] }))}
          />
        </div>

        {mode === "custom" && customProfiles.length > 0 ? (
          <div className={styles.row}>
            <div className={styles.rowText}>
              <p id="default-profile-label" className={styles.rowLabel}>
                Custom profile
              </p>
              <p className={styles.rowHelp}>The rule set new threads use in Custom mode.</p>
            </div>
            <SegmentedControl<string>
              aria-labelledby="default-profile-label"
              value={settings?.defaultProfileId ?? customProfiles[0]?.id ?? ""}
              onValueChange={(profileId) => void setDefaultMode("custom", { profileId })}
              options={customProfiles.map((profile) => ({ value: profile.id, label: profile.name }))}
            />
          </div>
        ) : null}
      </div>

      <ProfileList profiles={profiles} />
    </Panel>
  );
}

function ProfileList({ profiles }: { profiles: PermissionProfile[] }) {
  if (profiles.length === 0) return null;
  const groups = [
    { title: "Modes", items: profiles.filter((p) => p.mode !== "custom") },
    { title: "Custom profiles", items: profiles.filter((p) => p.mode === "custom") },
  ];
  return (
    <div className={styles.profiles}>
      {groups.map((group) =>
        group.items.length === 0 ? null : (
          <div key={group.title} className={styles.profileGroup}>
            <h3 className={styles.groupTitle}>{group.title}</h3>
            {group.items.map((profile) => (
              <details key={profile.id} className={styles.profile}>
                <summary className={styles.summary}>
                  <span className={styles.profileName}>{profile.name}</span>
                  <span className={styles.profileMeta}>
                    {profile.rules.filter((r) => r.effect === "allow").length} allowed ·{" "}
                    {profile.rules.filter((r) => r.effect === "ask").length} ask ·{" "}
                    {profile.rules.filter((r) => r.effect === "deny" || r.effect === "never").length} blocked
                  </span>
                </summary>
                <table className={styles.rules}>
                  <caption className="visually-hidden">{profile.name} rules</caption>
                  <thead>
                    <tr>
                      <th scope="col">Permission</th>
                      <th scope="col">Behaviour</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.rules.map((rule) => (
                      <tr key={`${rule.scope}-${rule.matcher ?? ""}`}>
                        <th scope="row">
                          {SCOPE_LABELS[rule.scope]}
                          {rule.matcher ? <code className={styles.matcher}>{rule.matcher}</code> : null}
                        </th>
                        <td>
                          <span className={styles.effect} data-effect={rule.effect}>
                            {EFFECT_LABELS[rule.effect]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
          </div>
        ),
      )}
    </div>
  );
}
