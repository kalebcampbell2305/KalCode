import type { PermissionMode, PermissionProfile } from "@kalcode/protocol";
import { Button, Panel, SegmentedControl } from "@kalcode/ui/components";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { useId, useState } from "react";
import { EFFECT_LABELS, MODE_DESCRIPTIONS, MODE_LABELS, SCOPE_LABELS } from "./labels.ts";
import { usePermissions } from "./PermissionsProvider.tsx";
import styles from "./PermissionsSettings.module.css";

const MODES: readonly PermissionMode[] = ["plan", "approve", "auto", "bypass", "custom"];

/** Settings → Permissions: default mode for new threads, Bypass confirmation, profiles. */
export function PermissionsSettings() {
  const { settings, profiles, setDefaultMode } = usePermissions();
  const [confirming, setConfirming] = useState(false);
  const customProfiles = profiles.filter((profile) => profile.mode === "custom");
  const mode = settings?.defaultMode ?? "approve";

  const choose = (next: PermissionMode) => {
    if (next === "bypass") {
      setConfirming(true);
      return;
    }
    const profileId = next === "custom" ? (settings?.defaultProfileId ?? customProfiles[0]?.id ?? null) : null;
    void setDefaultMode(next, { profileId });
  };

  return (
    <Panel
      id="permissions"
      title="Permissions"
      icon={<ShieldCheck />}
      description="How much agents, providers and KalVoice may do without asking. Every mode is available on every plan."
      padding="none"
      bodyClassName={styles.body}
      className={styles.panel}
      data-bypass={mode === "bypass" || undefined}
    >
      {mode === "bypass" ? (
        <div className={styles.bypassBanner} role="status">
          <TriangleAlert aria-hidden="true" />
          <div>
            <p className={styles.bannerTitle}>Bypass is on for new threads</p>
            <p className={styles.bannerText}>
              Local commands, file changes and deletions run without asking. Pushes, deploys, cloud changes, messages,
              spending, secrets and files outside the workspace still ask.
            </p>
          </div>
          <Button size="sm" onClick={() => void setDefaultMode("approve")}>
            Switch to Approve
          </Button>
        </div>
      ) : null}

      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.rowText}>
            <p id="default-mode-label" className={styles.rowLabel}>
              Default mode for new threads
            </p>
            <p id="default-mode-help" className={styles.rowHelp}>
              {MODE_DESCRIPTIONS[mode]}
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

      <BypassConfirm
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={async () => {
          if (await setDefaultMode("bypass", { confirmed: true })) setConfirming(false);
        }}
      />
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

function BypassConfirm({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const checkboxId = useId();
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setUnderstood(false);
        onOpenChange(next);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={styles.overlay} />
        <AlertDialog.Content className={styles.dialog}>
          <div className={styles.dialogIcon} aria-hidden="true">
            <TriangleAlert />
          </div>
          <AlertDialog.Title className={styles.dialogTitle}>Turn on Bypass for new threads?</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className={styles.dialogBody}>
              <p>New threads will get broad local authority. Without asking you, agents will be able to:</p>
              <ul>
                <li>change and delete files in the workspace, including recursive deletes</li>
                <li>run any local command and install packages</li>
                <li>commit to the local Git repository and use the network</li>
              </ul>
              <p>
                These still ask every time: pushing to Git remotes, deploying, changing cloud resources, sending
                messages, spending money, reading secrets, and files outside the workspace. Commands KalCode can't fully
                check always ask.
              </p>
              <p>
                Claude Code threads can't show KalCode's questions yet. For them, KalCode refuses pushes, publishes,
                deploys, cloud tools and reading credential files. Other commands follow Claude Code's own rules and
                your Claude Code settings.
              </p>
              <p>Agents and KalVoice can never turn Bypass on. You can switch back at any time.</p>
            </div>
          </AlertDialog.Description>
          <label className={styles.check} htmlFor={checkboxId}>
            <input
              id={checkboxId}
              type="checkbox"
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
            />
            I understand that agents will act without asking for local work.
          </label>
          <div className={styles.dialogActions}>
            <AlertDialog.Cancel asChild>
              <Button>Keep current mode</Button>
            </AlertDialog.Cancel>
            <Button
              variant="danger"
              disabled={!understood}
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                } finally {
                  setBusy(false);
                  setUnderstood(false);
                }
              }}
            >
              Turn on Bypass
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
