/**
 * The Command Deck's bottom strip: the Provider Dock of accounts, then builds, tests, provider
 * health and what is shipping, each one compact segment read from Operations and Provider Health.
 * A segment says "none" rather than guess when nothing has been observed.
 */
import type { StatusTone } from "@kalcode/protocol";
import { Tooltip } from "@kalcode/ui/components";
import { FlaskConical, Hammer, PauseCircle, PlugZap, Rocket } from "lucide-react";
import type { ReactNode } from "react";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNow } from "../../surfaces/dashboard/useNow.ts";
import { useNavigation } from "../navigation.tsx";
import { useDeckData } from "./DeckData.tsx";
import {
  ago,
  BUILD_KINDS,
  ENVIRONMENT_LABELS,
  environmentTone,
  humanize,
  primaryEnvironment,
  providerRollup,
  type RunSummary,
  runSummary,
  runTone,
  SHIP_KINDS,
  TEST_KINDS,
} from "./deckModel.ts";
import { ProviderDock } from "./ProviderDock.tsx";
import styles from "./StatusStrip.module.css";

export function StatusStrip() {
  const { operations, health } = useDeckData();
  const { active } = useWorkspaces();
  const { navigate } = useNavigation();
  const now = useNow(30_000);
  const items = operations.data?.items ?? [];
  const unknownRuns = operations.data === null;

  const builds = runSummary(items, BUILD_KINDS);
  const tests = runSummary(items, TEST_KINDS);
  const ships = runSummary(items, SHIP_KINDS);
  const providers = providerRollup(health.data);
  const environment = primaryEnvironment(operations.data?.environments ?? [], active?.id ?? null);

  const runWords = (summary: RunSummary, noun: string, passed: string) => {
    if (unknownRuns) return { value: operations.failed ? "Unavailable" : "Checking", detail: "" };
    switch (summary.state) {
      case "running":
        return {
          value: summary.running === 1 ? "Running" : `${summary.running} running`,
          detail: summary.latest?.spec.name ?? "",
        };
      case "passed":
        return { value: passed, detail: ago(summary.latest?.endedAt ?? null, now) };
      case "failed":
        return { value: "Failed", detail: ago(summary.latest?.endedAt ?? null, now) };
      case "cancelled":
        return { value: "Cancelled", detail: ago(summary.latest?.endedAt ?? null, now) };
      case "queued":
        return { value: `${summary.queued} queued`, detail: "" };
      default:
        return { value: `No ${noun}`, detail: "" };
    }
  };

  const build = runWords(builds, "builds", "Passed");
  const test = runWords(tests, "test runs", "Passed");

  // Shipping: a deploy or release in flight wins; then the furthest environment observed; then the
  // last deploy/release run's outcome.
  const ship =
    ships.state === "running"
      ? { tone: runTone("running"), value: "Shipping", detail: ships.latest?.spec.name ?? "" }
      : environment && environment.kind !== "local"
        ? {
            tone: environmentTone(environment),
            value: ENVIRONMENT_LABELS[environment.kind],
            detail: [environment.version, humanize(environment.deploymentStatus).toLowerCase()]
              .filter(Boolean)
              .join(" · "),
          }
        : ships.state !== "none"
          ? {
              tone: runTone(ships.state),
              value: runWords(ships, "deployments", "Shipped").value,
              detail: ago(ships.latest?.endedAt ?? null, now),
            }
          : { tone: "muted" as StatusTone, value: unknownRuns ? "Checking" : "Nothing shipping", detail: "" };

  return (
    <footer className={styles.strip}>
      <ProviderDock />
      <Segment
        icon={<Hammer />}
        label="Builds"
        spoken="Build status"
        tone={unknownRuns ? "muted" : runTone(builds.state)}
        pulse={builds.state === "running"}
        value={build.value}
        detail={build.detail}
        onClick={() => navigate("operations")}
        title={
          builds.latest
            ? `Latest build: ${builds.latest.spec.name} in ${builds.latest.workspaceName}`
            : "Builds run from Operations"
        }
      />
      <Segment
        icon={<FlaskConical />}
        label="Tests"
        spoken="Test status"
        tone={unknownRuns ? "muted" : runTone(tests.state)}
        pulse={tests.state === "running"}
        value={test.value}
        detail={test.detail}
        onClick={() => navigate("operations")}
        title={
          tests.latest
            ? `Latest test run: ${tests.latest.spec.name} in ${tests.latest.workspaceName}`
            : "Tests run from Operations"
        }
      />
      <Segment
        icon={<PlugZap />}
        label="Providers"
        spoken="Provider status"
        tone={providers.tone}
        value={health.failed && !health.data ? "Unknown" : providers.label}
        detail={
          providers.tone !== "muted" && providers.healthy < providers.installed
            ? `${providers.healthy}/${providers.installed} healthy`
            : ""
        }
        onClick={() => navigate("providers")}
        title="Provider health: installed provider CLIs, sign-in and recent failures"
      />
      <Segment
        icon={<Rocket />}
        label="Deploy"
        spoken="Shipping status"
        tone={ship.tone}
        pulse={ships.state === "running"}
        value={ship.value}
        detail={ship.detail}
        onClick={() => navigate("operations")}
        title="What is shipping: deploys, releases and the furthest environment observed for this workspace"
      />
      <span className={styles.spacer} />
      {operations.data?.paused ? (
        <button type="button" className={styles.notice} onClick={() => navigate("operations")}>
          <PauseCircle aria-hidden="true" />
          Queue paused
        </button>
      ) : null}
    </footer>
  );
}

interface SegmentProps {
  icon: ReactNode;
  label: string;
  /** The accessible name's lead ("Build status"), distinct from navigation names. */
  spoken: string;
  tone: StatusTone;
  value: string;
  detail: string;
  pulse?: boolean;
  title: string;
  onClick: () => void;
}

function Segment({ icon, label, spoken, tone, value, detail, pulse = false, title, onClick }: SegmentProps) {
  return (
    <Tooltip content={title} side="top">
      <button
        type="button"
        className={styles.segment}
        data-tone={tone}
        onClick={onClick}
        aria-label={`${spoken}: ${value}${detail ? `, ${detail}` : ""}`}
      >
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
        <span className={styles.label}>{label}</span>
        <span className={styles.dot} data-pulse={pulse || undefined} aria-hidden="true" />
        <span className={styles.value}>{value}</span>
        {detail ? <span className={styles.detail}>{detail}</span> : null}
      </button>
    </Tooltip>
  );
}
