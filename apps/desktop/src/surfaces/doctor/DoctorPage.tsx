import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  CheckResult,
  DoctorApi,
  DoctorFinding,
  DoctorRun,
  FixLogEntry,
  FixPreview,
  FixRequest,
  IgnoredFinding,
} from "../../ipc/doctor";
import styles from "./DoctorPage.module.css";
import { AREA_LABEL, checksByArea, fixRequest, progress, visibleFindings } from "./doctorModel";

export interface DoctorPageProps {
  api: DoctorApi;
  workspaceId?: string;
}

type BusyAction = "run" | "cancel" | "fix" | "ignore" | "revert";

/** A running check list is re-read this often, backing off to the maximum while nothing changes. */
const RUN_POLL_MS = 500;
const RUN_POLL_MAX_MS = 2_000;

export function DoctorPage({ api, workspaceId }: DoctorPageProps) {
  const [snapshot, setSnapshot] = useState<DoctorRun | null>(null);
  const [preview, setPreview] = useState<FixPreview | null>(null);
  const [pendingRequest, setPendingRequest] = useState<FixRequest | null>(null);
  const [pendingRevert, setPendingRevert] = useState<{ fixLogId: string; approvalId: string } | null>(null);
  const [fixLog, setFixLog] = useState<FixLogEntry[]>([]);
  const [ignored, setIgnored] = useState<IgnoredFinding[]>([]);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [latest, fixes, ignoredList] = await Promise.all([api.last(), api.fixLog(50), api.ignored()]);
    setSnapshot(latest);
    setFixLog(fixes);
    setIgnored(ignoredList.items);
  }, [api]);

  useEffect(() => {
    void refresh().catch(() => setError("Environment Doctor status could not be loaded."));
  }, [refresh]);

  // During a run only its status moves: poll just the run, slower while nothing changes (and while
  // the window is hidden), and re-read the fix log and ignored list once when it ends.
  // A cancelled run stays active until its in-flight checks return; keep polling until it has
  // finished so the findings of the checks that completed are loaded.
  const runningId = snapshot && snapshot.finishedAt === null ? snapshot.id : null;
  useEffect(() => {
    if (!runningId) return;
    let disposed = false;
    let timer: number | undefined;
    let delay = RUN_POLL_MS;
    let lastSeen = "";
    const poll = async () => {
      try {
        const latest = await api.last();
        if (disposed) return;
        if (!latest || latest.finishedAt !== null) {
          await refresh();
          return;
        }
        const seen = JSON.stringify(latest);
        if (seen === lastSeen) delay = Math.min(delay * 2, RUN_POLL_MAX_MS);
        else {
          delay = RUN_POLL_MS;
          lastSeen = seen;
          setSnapshot(latest);
        }
      } catch {
        if (disposed) return;
        setError("The current diagnostic status could not be refreshed.");
      }
      const wait = document.visibilityState === "hidden" ? RUN_POLL_MAX_MS : delay;
      timer = window.setTimeout(() => void poll(), wait);
    };
    timer = window.setTimeout(() => void poll(), RUN_POLL_MS);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [api, refresh, runningId]);

  const groups = useMemo(() => (snapshot ? checksByArea(snapshot) : []), [snapshot]);
  const findings = useMemo(() => (snapshot ? visibleFindings(snapshot, false) : []), [snapshot]);
  const runProgress = useMemo(() => (snapshot ? progress(snapshot) : { completed: 0, total: 0 }), [snapshot]);

  const run = async () => {
    setBusy("run");
    setError(null);
    setNotice(null);
    try {
      setSnapshot(await api.run({ areas: [], checks: [], workspaceId: workspaceId ?? null }));
    } catch {
      setError("Environment Doctor could not start. No changes were made.");
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    setError(null);
    try {
      if (!snapshot) return;
      setSnapshot(await api.cancel(snapshot.id));
      setNotice("Cancellation requested. Completed checks remain available.");
    } catch {
      setError("The diagnostic run could not be cancelled.");
    } finally {
      setBusy(null);
    }
  };

  const inspectFix = async (finding: DoctorFinding) => {
    const option = finding.fixes[0];
    if (!snapshot || !option) return;
    setError(null);
    try {
      const request = fixRequest(snapshot, finding, option.fixCode);
      setPendingRequest(request);
      setPreview(await api.previewFix(request));
    } catch {
      setError("The fix preview is no longer current. Run Environment Doctor again.");
    }
  };

  const applyFix = async () => {
    if (!pendingRequest) return;
    setBusy("fix");
    setError(null);
    try {
      const result = await api.fix(pendingRequest);
      if (result.kind === "awaiting_approval") {
        setPendingRequest({ ...pendingRequest, approvalId: result.approvalId });
        setNotice("Review the native approval request, then choose Continue.");
      } else if (result.kind === "denied") {
        setError(result.reason);
      } else if (result.kind === "show_command") {
        setNotice("The command is shown for you to review and run yourself.");
      } else {
        setNotice(result.message);
        setPreview(null);
        setPendingRequest(null);
        await refresh();
      }
    } catch {
      setError("The fix was refused because its authorization or target was no longer current.");
    } finally {
      setBusy(null);
    }
  };

  const ignore = async (finding: DoctorFinding) => {
    if (!snapshot) return;
    setBusy("ignore");
    setError(null);
    try {
      await api.ignore({
        findingCode: finding.code,
        // A finding outside the project (tools, system, providers) is ignored everywhere.
        scope: finding.workspaceId ? { kind: "workspace", workspaceId: finding.workspaceId } : { kind: "global" },
        ignored: true,
      });
      setNotice("Finding ignored. You can restore it from Environment Doctor settings.");
      await refresh();
    } catch {
      setError("The finding could not be ignored because the run is no longer current.");
    } finally {
      setBusy(null);
    }
  };

  const restoreIgnored = async (finding: IgnoredFinding) => {
    setBusy("ignore");
    setError(null);
    try {
      setSnapshot(
        await api.ignore({
          findingCode: finding.findingCode,
          scope: finding.scope,
          ignored: false,
        }),
      );
      setNotice("Finding restored.");
      await refresh();
    } catch {
      setError("The ignored finding could not be restored.");
    } finally {
      setBusy(null);
    }
  };

  const undo = async (entry: FixLogEntry) => {
    if (!entry.id) return;
    setBusy("revert");
    setError(null);
    try {
      const result = await api.revert({ fixLogId: entry.id, approvalId: null });
      if (result.kind === "awaiting_approval") {
        setPendingRevert({ fixLogId: entry.id, approvalId: result.approvalId });
        setNotice("Review the native approval request, then continue Undo.");
      } else if (result.kind === "denied") {
        setError(result.reason);
      } else if (result.kind === "done") {
        setNotice(result.message);
        await refresh();
      }
    } catch {
      setError("Undo was refused because the target or approval was no longer current.");
    } finally {
      setBusy(null);
    }
  };

  const continueUndo = async () => {
    if (!pendingRevert) return;
    setBusy("revert");
    setError(null);
    try {
      const result = await api.revert(pendingRevert);
      if (result.kind === "awaiting_approval") {
        setNotice("The native approval is still waiting for your answer.");
      } else if (result.kind === "denied") {
        setError(result.reason);
        setPendingRevert(null);
      } else if (result.kind === "done") {
        setNotice(result.message);
        setPendingRevert(null);
        await refresh();
      }
    } catch {
      setError("Undo was refused because the target or approval was no longer current.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={styles.page} aria-labelledby="doctor-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Local diagnostics</p>
          <h1 id="doctor-title">Environment Doctor</h1>
          <p className={styles.intro}>
            Check KalCode, development tools, providers, system resources, and the active project. Checks do not contact
            providers or change your computer.
          </p>
        </div>
        <div className={styles.actions}>
          {snapshot?.status === "running" ? (
            <button type="button" className={styles.secondaryButton} disabled={busy !== null} onClick={cancel}>
              {busy === "cancel" ? "Cancelling…" : "Cancel"}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.primaryButton}
            disabled={busy !== null || snapshot?.status === "running"}
            onClick={run}
          >
            {busy === "run" ? "Starting…" : snapshot ? "Run again" : "Run checks"}
          </button>
        </div>
      </header>

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      ) : null}

      {snapshot ? (
        <section className={styles.summary} aria-live="polite">
          <div>
            <span className={styles.summaryValue}>
              {runProgress.completed}/{runProgress.total}
            </span>
            <span className={styles.summaryLabel}>checks complete</span>
          </div>
          <div>
            <span className={styles.summaryValue}>{findings.length}</span>
            <span className={styles.summaryLabel}>visible findings</span>
          </div>
          <div>
            <span className={styles.summaryValue}>{snapshot.status.replaceAll("_", " ")}</span>
            <span className={styles.summaryLabel}>run status</span>
          </div>
          <progress value={runProgress.completed} max={Math.max(runProgress.total, 1)}>
            {runProgress.completed} of {runProgress.total}
          </progress>
        </section>
      ) : (
        <section className={styles.empty}>
          <h2>Ready when you are</h2>
          <p>
            Environment Doctor reports only bounded, owner-safe findings. Every change has a preview and native
            approval.
          </p>
        </section>
      )}

      {groups.map(({ area, checks }) => (
        <section key={area} className={styles.area} aria-labelledby={`doctor-area-${area}`}>
          <h2 id={`doctor-area-${area}`}>{AREA_LABEL[area]}</h2>
          <div className={styles.checkGrid}>
            {checks.map((check) => (
              <CheckCard key={check.id} check={check} />
            ))}
          </div>
        </section>
      ))}

      {findings.length > 0 ? (
        <section className={styles.findings} aria-labelledby="doctor-findings-title">
          <h2 id="doctor-findings-title">Findings</h2>
          <div className={styles.findingList}>
            {findings.map((finding) => (
              <article key={`${finding.code}:${finding.version}`} className={styles.finding}>
                <div className={styles.findingHeader}>
                  <span className={styles.severity} data-severity={finding.severity}>
                    {finding.severity}
                  </span>
                  <h3>{finding.title}</h3>
                </div>
                <p>{finding.explanation}</p>
                {finding.details.length > 0 ? (
                  <dl>
                    {finding.details.map((detail) => (
                      <div key={`${detail.label}:${detail.value}`}>
                        <dt>{detail.label}</dt>
                        <dd>{detail.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <div className={styles.findingActions}>
                  {finding.fixes.length > 0 ? (
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={busy !== null}
                      onClick={() => void inspectFix(finding)}
                    >
                      Preview fix
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.ghostButton}
                    disabled={busy !== null}
                    onClick={() => void ignore(finding)}
                  >
                    Ignore
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {fixLog.length > 0 ? (
        <section className={styles.findings} aria-labelledby="doctor-fix-log-title">
          <h2 id="doctor-fix-log-title">Recent fixes</h2>
          <div className={styles.findingList}>
            {fixLog.map((entry) => (
              <article key={entry.id ?? entry.findingCode} className={styles.finding}>
                <div className={styles.findingHeader}>
                  <span className={styles.severity}>{entry.status.replaceAll("_", " ")}</span>
                  <h3>{entry.summary}</h3>
                </div>
                {entry.error ? <p>Recovery state: {entry.error.replaceAll("_", " ")}</p> : null}
                {entry.canUndo && entry.id ? (
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={busy !== null}
                    onClick={() => void undo(entry)}
                  >
                    Undo
                  </button>
                ) : null}
              </article>
            ))}
          </div>
          {pendingRevert ? (
            <button
              type="button"
              className={styles.primaryButton}
              disabled={busy !== null}
              onClick={() => void continueUndo()}
            >
              {busy === "revert" ? "Checking approval…" : "Continue Undo"}
            </button>
          ) : null}
        </section>
      ) : null}

      {ignored.length > 0 ? (
        <section className={styles.findings} aria-labelledby="doctor-ignored-title">
          <h2 id="doctor-ignored-title">Ignored findings</h2>
          <div className={styles.findingList}>
            {ignored.map((finding) => (
              <article key={finding.findingCode + JSON.stringify(finding.scope)} className={styles.finding}>
                <h3>{finding.title}</h3>
                <p>{finding.scope.kind === "global" ? "Ignored everywhere" : "Ignored in this workspace"}</p>
                <button
                  type="button"
                  className={styles.ghostButton}
                  disabled={busy !== null}
                  onClick={() => void restoreIgnored(finding)}
                >
                  Restore
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {preview ? (
        <div className={styles.backdrop}>
          <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="doctor-fix-title">
            <p className={styles.eyebrow}>Fix preview</p>
            <h2 id="doctor-fix-title">{preview.fix.label}</h2>
            <p>{preview.fix.description}</p>
            <div className={styles.changeBox}>
              <span>Planned change</span>
              {preview.changes.map((change) => (
                <strong key={change}>{change}</strong>
              ))}
            </div>
            {preview.target ? <p className={styles.permission}>Target: {preview.target}</p> : null}
            <p className={styles.permission}>Undo: {preview.undo}</p>
            {preview.fix.command ? (
              <pre>
                <code>{preview.fix.command}</code>
              </pre>
            ) : null}
            <div className={styles.dialogActions}>
              <button
                type="button"
                className={styles.ghostButton}
                disabled={busy !== null}
                onClick={() => setPreview(null)}
              >
                Close
              </button>
              {preview.needsApproval ? (
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={busy !== null}
                  onClick={() => void applyFix()}
                >
                  {busy === "fix" ? "Checking approval…" : pendingRequest?.approvalId ? "Continue" : "Request approval"}
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function CheckCard({ check }: { check: CheckResult }) {
  return (
    <article className={styles.check} data-status={check.status}>
      <div>
        <h3>{check.title}</h3>
        <p>{check.summary}</p>
      </div>
      <span className={styles.checkStatus}>{check.status.replaceAll("_", " ")}</span>
    </article>
  );
}
