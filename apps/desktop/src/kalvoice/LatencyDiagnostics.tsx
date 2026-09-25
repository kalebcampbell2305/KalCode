import type { LatencySnapshot, LatencyStage, StageTimings } from "@kalcode/protocol";
import { Button, Section } from "@kalcode/ui/components";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import styles from "./LatencyDiagnostics.module.css";

const STAGES: { stage: LatencyStage; key: keyof StageTimings; label: string; budget: number | null }[] = [
  { stage: "key_down_to_mic", key: "keyDownToMic", label: "Key down → microphone", budget: 50 },
  { stage: "speech_to_partial", key: "speechToPartial", label: "Speech → first partial", budget: null },
  { stage: "key_up_to_final", key: "keyUpToFinal", label: "Key up → final transcript", budget: 250 },
  { stage: "final_to_recognized", key: "finalToRecognized", label: "Final → recognized", budget: 5 },
  { stage: "recognized_to_action", key: "recognizedToAction", label: "Recognized → visible action", budget: 100 },
];

function ms(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}

/** Developer builds: per-request stage waterfall and rolling percentiles (monotonic timings). */
export function LatencyDiagnostics() {
  const { client } = useRuntime();
  const [snapshot, setSnapshot] = useState<LatencySnapshot | null>(null);
  const refresh = useCallback(async () => {
    try {
      setSnapshot(await client.kalvoiceLatency());
    } catch {
      setSnapshot(null);
    }
  }, [client]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const recent = snapshot?.recent ?? [];
  const widest = Math.max(
    1,
    ...recent.map((t) => STAGES.reduce((sum, s) => sum + ((t[s.key] as number | null) ?? 0), 0)),
  );

  return (
    <Section
      id="kalvoice-latency"
      title="Latency (developer build)"
      description="Measured on this computer with monotonic timers, from the push-to-talk key down to the visible result."
      actions={
        <Button size="sm" icon={<RefreshCw />} onClick={() => void refresh()}>
          Refresh
        </Button>
      }
    >
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">p50</th>
            <th scope="col">p95</th>
            <th scope="col">p99</th>
            <th scope="col">Target p95</th>
            <th scope="col">Samples</th>
          </tr>
        </thead>
        <tbody>
          {STAGES.map((s) => {
            const row = snapshot?.stages.find((p) => p.stage === s.stage);
            const over = s.budget !== null && row?.p95 !== null && row?.p95 !== undefined && row.p95 > s.budget;
            return (
              <tr key={s.stage}>
                <th scope="row">{s.label}</th>
                <td>{ms(row?.p50)}</td>
                <td data-over={over || undefined}>{ms(row?.p95)}</td>
                <td>{ms(row?.p99)}</td>
                <td>{s.budget === null ? "–" : `${s.budget} ms`}</td>
                <td>{row?.count ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {recent.length === 0 ? (
        <p className={styles.empty}>No requests measured yet. Hold the push-to-talk key and speak.</p>
      ) : (
        <ol className={styles.waterfall} aria-label="Recent requests, newest first">
          {recent.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-order list of recent timings.
            <li key={i} className={styles.request}>
              <span className={styles.bars}>
                {STAGES.map((s) => {
                  const v = (t[s.key] as number | null) ?? 0;
                  return (
                    <span
                      key={s.stage}
                      className={styles.bar}
                      data-stage={s.stage}
                      style={{ width: `${(v / widest) * 100}%` }}
                      title={`${s.label}: ${ms(v)}`}
                    />
                  );
                })}
              </span>
              <span className={styles.total}>
                {ms(STAGES.reduce((sum, s) => sum + ((t[s.key] as number | null) ?? 0), 0))}
                {t.finalSource === "reused_partial" ? " · no pass after release" : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
