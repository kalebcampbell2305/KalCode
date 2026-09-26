import { useEffect, useMemo, useState } from "react";
import type {
  EnvListing,
  HttpResponseView,
  ListeningPort,
  ProcessInfo,
  Scratchpad,
  SqliteHandle,
  SqliteQueryResult,
  UtilityApi,
  UtilityEffectOutcome,
} from "../../ipc/utilities.ts";
import { UtilityIpcError } from "../../ipc/utilities.ts";
import { Page } from "../../shell/Page.tsx";
import styles from "./UtilityDock.module.css";
import {
  type DiffRow,
  diffLines,
  formatJson,
  LatestOperation,
  type TextTransform,
  transformText,
} from "./utilitiesModel.ts";

export interface UtilityDockProps {
  api: UtilityApi;
  openScratchTerminal?: () => void;
}

type Tab =
  | "api"
  | "json"
  | "diff"
  | "encode"
  | "processes"
  | "ports"
  | "environment"
  | "sqlite"
  | "regex"
  | "notes"
  | "scratch_terminal";

const TABS: ReadonlyArray<{ id: Tab; label: string; group: string }> = [
  { id: "api", label: "API", group: "Network" },
  { id: "json", label: "JSON", group: "Transform" },
  { id: "diff", label: "Diff", group: "Transform" },
  { id: "encode", label: "Encode & hash", group: "Transform" },
  { id: "processes", label: "Processes", group: "System" },
  { id: "ports", label: "Ports", group: "System" },
  { id: "environment", label: "Environment", group: "System" },
  { id: "sqlite", label: "SQLite", group: "Data" },
  { id: "regex", label: "Regex", group: "Workbench" },
  { id: "notes", label: "Notes", group: "Workbench" },
  { id: "scratch_terminal", label: "Scratch terminal", group: "Workbench" },
];

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

function safeMessage(error: unknown): string {
  return error instanceof UtilityIpcError ? error.message : "The Utility Dock could not complete that action.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function Heading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return (
    <header className={styles.panelHeading}>
      <span>{eyebrow}</span>
      <h2>{title}</h2>
      <p>{detail}</p>
    </header>
  );
}

export function UtilityDock({ api, openScratchTerminal }: UtilityDockProps) {
  const [active, setActive] = useState<Tab>("api");
  const [error, setError] = useState<string | null>(null);
  const [capability, setCapability] = useState<"probing" | "ready" | "unavailable">("probing");
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [method, setMethod] = useState<(typeof METHODS)[number]>("GET");
  const [url, setUrl] = useState("");
  const [requestBody, setRequestBody] = useState("");
  const [response, setResponse] = useState<HttpResponseView | null>(null);
  const [pendingHttpApproval, setPendingHttpApproval] = useState<string | null>(null);
  const [requestBusy, setRequestBusy] = useState(false);
  const requestOperation = useMemo(
    () =>
      new LatestOperation<UtilityEffectOutcome>(
        (outcome) => {
          if (outcome.kind === "awaiting_approval") {
            setPendingHttpApproval(outcome.approvalId);
          } else if (outcome.kind === "http_completed") {
            setPendingHttpApproval(null);
            setResponse(outcome.response);
          } else {
            setError("The native utility returned a result for a different action.");
          }
          setRequestBusy(false);
        },
        (failure) => {
          setError(safeMessage(failure));
          setRequestBusy(false);
        },
      ),
    [],
  );

  const [jsonInput, setJsonInput] = useState("");
  const [jsonOutput, setJsonOutput] = useState("");
  const [leftText, setLeftText] = useState("");
  const [rightText, setRightText] = useState("");
  const [diff, setDiff] = useState<DiffRow[]>([]);
  const [transform, setTransform] = useState<TextTransform>("base64_encode");
  const [transformInput, setTransformInput] = useState("");
  const [transformOutput, setTransformOutput] = useState("");

  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [processBusy, setProcessBusy] = useState(false);
  const [confirmPid, setConfirmPid] = useState<number | null>(null);
  const [pendingProcess, setPendingProcess] = useState<{ approvalId: string; pid: number; name: string } | null>(null);
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [portSource, setPortSource] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<EnvListing | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; value: string } | null>(null);

  const [database, setDatabase] = useState<SqliteHandle | null>(null);
  const [sql, setSql] = useState("SELECT name, type FROM sqlite_schema ORDER BY name;");
  const [query, setQuery] = useState<SqliteQueryResult | null>(null);
  const [confirmSql, setConfirmSql] = useState(false);
  const [pendingSqlApproval, setPendingSqlApproval] = useState<string | null>(null);
  const [pattern, setPattern] = useState("");
  const [regexText, setRegexText] = useState("");
  const [regexSummary, setRegexSummary] = useState<string | null>(null);
  const [notes, setNotes] = useState<Scratchpad[]>([]);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [deleteNote, setDeleteNote] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void api.status().then(
      (status) => {
        if (current) {
          setCapability("ready");
          setPersistent(status.persistent);
        }
      },
      () => {
        if (current) setCapability("unavailable");
      },
    );
    return () => {
      current = false;
    };
  }, [api]);

  useEffect(() => {
    let current = true;
    setError(null);
    if (active === "processes") {
      setProcessBusy(true);
      void api
        .processes("related")
        .then(
          (result) => {
            if (current) setProcesses(result.processes);
          },
          (failure) => {
            if (current) setError(safeMessage(failure));
          },
        )
        .finally(() => {
          if (current) setProcessBusy(false);
        });
    } else if (active === "ports") {
      void api.ports().then(
        (result) => {
          if (current) {
            setPorts(result.ports);
            setPortSource(result.source);
          }
        },
        (failure) => {
          if (current) setError(safeMessage(failure));
        },
      );
    } else if (active === "environment") {
      void api.envList({ kind: "kal_code" }).then(
        (result) => {
          if (current) setEnvironment(result);
        },
        (failure) => {
          if (current) setError(safeMessage(failure));
        },
      );
    } else if (active === "notes") {
      void api.scratchpads(null).then(
        (result) => {
          if (current) setNotes(result.items);
        },
        (failure) => {
          if (current) setError(safeMessage(failure));
        },
      );
    }
    return () => {
      current = false;
    };
  }, [active, api]);

  function chooseTab(tab: Tab) {
    requestOperation.cancel();
    setRequestBusy(false);
    setError(null);
    setActive(tab);
  }

  async function sendRequest() {
    setError(null);
    setResponse(null);
    setPendingHttpApproval(null);
    setRequestBusy(true);
    await requestOperation.run(() =>
      api.httpSend({
        method,
        url,
        body: requestBody || null,
      }),
    );
  }

  async function continueRequest() {
    if (!pendingHttpApproval) return;
    setError(null);
    setRequestBusy(true);
    await requestOperation.run(() => api.effectContinue(pendingHttpApproval));
  }

  async function finishProcessOutcome(outcome: UtilityEffectOutcome, process: ProcessInfo) {
    if (outcome.kind === "awaiting_approval") {
      setPendingProcess({ approvalId: outcome.approvalId, pid: process.pid, name: process.name });
      return;
    }
    if (outcome.kind !== "process_completed") {
      throw new UtilityIpcError(
        "utility_result_mismatch",
        "The native utility returned a result for a different action.",
      );
    }
    setPendingProcess(null);
    setProcesses((await api.processes("related")).processes);
  }

  async function signalProcess(process: ProcessInfo) {
    if (pendingProcess?.pid === process.pid) {
      try {
        await finishProcessOutcome(await api.effectContinue(pendingProcess.approvalId), process);
      } catch (failure) {
        setError(safeMessage(failure));
      }
      return;
    }
    if (confirmPid !== process.pid) {
      setConfirmPid(process.pid);
      return;
    }
    setConfirmPid(null);
    try {
      setConfirmPid(process.pid);
      await finishProcessOutcome(
        await api.processSignal({ pid: process.pid, startTime: process.startTime, signal: "terminate" }),
        process,
      );
      setConfirmPid(null);
    } catch (failure) {
      setError(safeMessage(failure));
    }
  }

  async function finishSqlOutcome(outcome: UtilityEffectOutcome) {
    if (outcome.kind === "awaiting_approval") {
      setPendingSqlApproval(outcome.approvalId);
      setConfirmSql(false);
      return;
    }
    if (outcome.kind !== "sqlite_completed") {
      throw new UtilityIpcError(
        "utility_result_mismatch",
        "The native utility returned a result for a different action.",
      );
    }
    setPendingSqlApproval(null);
    setQuery(null);
    setConfirmSql(false);
    setError(`${outcome.result.changes} row${outcome.result.changes === 1 ? "" : "s"} changed.`);
  }

  async function runSql() {
    if (!database) return;
    const readOnly = /^\s*(select|with|explain|pragma)\b/i.test(sql);
    try {
      if (pendingSqlApproval) {
        await finishSqlOutcome(await api.effectContinue(pendingSqlApproval));
      } else if (readOnly) {
        setQuery(await api.sqliteQuery(database.id, sql, null, 100));
        setConfirmSql(false);
      } else if (!confirmSql) {
        setConfirmSql(true);
      } else {
        await finishSqlOutcome(await api.sqliteWrite(database.id, sql));
      }
    } catch (failure) {
      setError(safeMessage(failure));
    }
  }

  async function saveNote() {
    try {
      await api.scratchpadSave({ id: null, workspaceId: null, title: noteTitle, content: noteContent });
      setNoteTitle("");
      setNoteContent("");
      setNotes((await api.scratchpads(null)).items);
    } catch (failure) {
      setError(safeMessage(failure));
    }
  }

  return (
    <Page title="Utility Dock">
      <section className={styles.dock} aria-label="Utility Dock">
        <header className={styles.hero}>
          <div>
            <span className={styles.kicker}>Developer instruments</span>
            <h1>Utility Dock</h1>
            <p>Bounded local tools and governed native actions, arranged around the work in front of you.</p>
          </div>
          <div className={styles.truth} data-state={capability} role="status" aria-label="Capability state">
            <i aria-hidden="true" />
            <div>
              <strong>
                {capability === "ready"
                  ? "Ready on demand"
                  : capability === "unavailable"
                    ? "Native tools unavailable"
                    : "Checking native tools"}
              </strong>
              <small>
                {capability === "ready"
                  ? `${persistent ? "Durable utility store" : "Session-only utility store"}; every result identifies its probe.`
                  : capability === "unavailable"
                    ? "The dock remains read-only until native authority returns."
                    : "No readiness claim before the probe completes."}
              </small>
            </div>
          </div>
        </header>
        <div className={styles.layout}>
          <nav className={styles.rail} aria-label="Utility tools">
            <div role="tablist" aria-orientation="vertical">
              {TABS.map((tab, index) => (
                <div className={styles.tabBlock} key={tab.id}>
                  {index === 0 || TABS[index - 1]?.group !== tab.group ? (
                    <span className={styles.group}>{tab.group}</span>
                  ) : null}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active === tab.id}
                    aria-controls={`utility-panel-${tab.id}`}
                    id={`utility-tab-${tab.id}`}
                    onClick={() => chooseTab(tab.id)}
                  >
                    <span>{tab.label}</span>
                    <i aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </nav>
          <main
            className={styles.panel}
            role="tabpanel"
            id={`utility-panel-${active}`}
            aria-labelledby={`utility-tab-${active}`}
          >
            {error ? (
              <div className={styles.notice} role="alert">
                {error}
              </div>
            ) : null}

            {active === "api" ? (
              <>
                <Heading
                  eyebrow="Governed network"
                  title="API inspector"
                  detail="Native destination checks, redirect controls, response limits, and timeouts keep each request bounded."
                />
                <div className={styles.requestLine}>
                  <label>
                    <span>Method</span>
                    <select
                      value={method}
                      disabled={pendingHttpApproval !== null}
                      onChange={(event) => setMethod(event.target.value as (typeof METHODS)[number])}
                    >
                      {METHODS.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </label>
                  <label className={styles.grow}>
                    <span>Request URL</span>
                    <input
                      value={url}
                      disabled={pendingHttpApproval !== null}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="https://api.example.com/health"
                    />
                  </label>
                  <button
                    className={styles.primary}
                    type="button"
                    disabled={!url || requestBusy}
                    onClick={() => void (pendingHttpApproval ? continueRequest() : sendRequest())}
                  >
                    {pendingHttpApproval ? "Continue approved request" : "Send request"}
                  </button>
                </div>
                <label className={styles.field}>
                  <span>Request body</span>
                  <textarea
                    value={requestBody}
                    disabled={pendingHttpApproval !== null}
                    onChange={(event) => setRequestBody(event.target.value)}
                    placeholder="Optional text or JSON"
                  />
                </label>
                {pendingHttpApproval ? (
                  <p className={styles.notice} role="status">
                    Approve each displayed step in Permissions, then continue it here. KalCode authorizes hostname
                    resolution first, then the pinned request to the resolved destination. Only the approval id is sent
                    on continuation.
                  </p>
                ) : null}
                {requestBusy ? (
                  <button
                    className={styles.quiet}
                    type="button"
                    onClick={() => {
                      requestOperation.cancel();
                      setRequestBusy(false);
                    }}
                  >
                    Stop waiting
                  </button>
                ) : null}
                <section className={styles.resultCard} aria-label="Response">
                  <div className={styles.resultHead}>
                    <span className={styles.state}>{response ? "Response received" : "Not probed"}</span>
                    {response ? (
                      <strong>
                        {response.status} {response.reason}
                      </strong>
                    ) : (
                      <span>Send a request to run a current probe.</span>
                    )}
                    {response ? (
                      <small>
                        {response.timing.totalMs} ms · {formatBytes(response.bytes)}
                        {response.truncated ? " · truncated" : ""}
                      </small>
                    ) : null}
                  </div>
                  {response ? <pre>{response.body || "No response body"}</pre> : null}
                </section>
              </>
            ) : null}

            {active === "json" ? (
              <>
                <Heading
                  eyebrow="Local transform"
                  title="JSON workbench"
                  detail="Format or compact bounded input without native authority or network access."
                />
                <div className={styles.split}>
                  <label className={styles.field}>
                    <span>JSON input</span>
                    <textarea value={jsonInput} onChange={(event) => setJsonInput(event.target.value)} />
                  </label>
                  <label className={styles.field}>
                    <span>JSON result</span>
                    <textarea readOnly value={jsonOutput} />
                  </label>
                </div>
                <div className={styles.actions}>
                  <button
                    className={styles.primary}
                    type="button"
                    onClick={() => {
                      const result = formatJson(jsonInput, "pretty");
                      if (result.ok) setJsonOutput(result.output);
                      else setError(result.message);
                    }}
                  >
                    Format JSON
                  </button>
                  <button
                    className={styles.quiet}
                    type="button"
                    onClick={() => {
                      const result = formatJson(jsonInput, "compact");
                      if (result.ok) setJsonOutput(result.output);
                      else setError(result.message);
                    }}
                  >
                    Compact
                  </button>
                </div>
              </>
            ) : null}

            {active === "diff" ? (
              <>
                <Heading
                  eyebrow="Local transform"
                  title="Line diff"
                  detail="A deterministic comparison bounded to 2,000 lines per side."
                />
                <div className={styles.split}>
                  <label className={styles.field}>
                    <span>Original</span>
                    <textarea value={leftText} onChange={(event) => setLeftText(event.target.value)} />
                  </label>
                  <label className={styles.field}>
                    <span>Changed</span>
                    <textarea value={rightText} onChange={(event) => setRightText(event.target.value)} />
                  </label>
                </div>
                <button
                  className={styles.primary}
                  type="button"
                  onClick={() => {
                    try {
                      setDiff(diffLines(leftText, rightText));
                    } catch (failure) {
                      setError(failure instanceof Error ? failure.message : "The texts could not be compared.");
                    }
                  }}
                >
                  Compare
                </button>
                {diff.length ? (
                  <div className={styles.diff}>
                    {diff.map((row) => (
                      <div data-kind={row.kind} key={`${row.kind}:${row.leftLine ?? "-"}:${row.rightLine ?? "-"}`}>
                        <span>{row.leftLine ?? row.rightLine ?? ""}</span>
                        <code>{row.left ?? row.right ?? ""}</code>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}

            {active === "encode" ? (
              <>
                <Heading
                  eyebrow="Local transform"
                  title="Encode & hash"
                  detail="Unicode-safe Base64, hexadecimal, URL transforms, and SHA-256 up to 1 MB."
                />
                <div className={styles.requestLine}>
                  <label>
                    <span>Operation</span>
                    <select value={transform} onChange={(event) => setTransform(event.target.value as TextTransform)}>
                      <option value="base64_encode">Base64 encode</option>
                      <option value="base64_decode">Base64 decode</option>
                      <option value="hex_encode">Hex encode</option>
                      <option value="hex_decode">Hex decode</option>
                      <option value="url_encode">URL encode</option>
                      <option value="url_decode">URL decode</option>
                      <option value="sha256">SHA-256</option>
                    </select>
                  </label>
                  <button
                    className={styles.primary}
                    type="button"
                    onClick={() =>
                      void transformText(transformInput, transform).then(setTransformOutput, (failure) =>
                        setError(failure instanceof Error ? failure.message : "The transform failed."),
                      )
                    }
                  >
                    Run transform
                  </button>
                </div>
                <div className={styles.split}>
                  <label className={styles.field}>
                    <span>Input</span>
                    <textarea value={transformInput} onChange={(event) => setTransformInput(event.target.value)} />
                  </label>
                  <label className={styles.field}>
                    <span>Result</span>
                    <textarea readOnly value={transformOutput} />
                  </label>
                </div>
              </>
            ) : null}

            {active === "processes" ? (
              <>
                <Heading
                  eyebrow="Governed system"
                  title="Process monitor"
                  detail="Every stop revalidates the sampled creation identity. Protected and foreign processes remain fail-closed."
                />
                {processBusy ? <p className={styles.muted}>Sampling processes…</p> : null}
                <ul className={styles.table} aria-label="Related processes">
                  {processes.map((process) => (
                    <li className={styles.processRow} key={`${process.pid}-${process.startTime}`}>
                      <div>
                        <strong>{process.name}</strong>
                        <small>
                          {process.label} · PID {process.pid}
                        </small>
                      </div>
                      <span>
                        {process.cpuPercent === null ? "warming" : `${process.cpuPercent.toFixed(1)}%`}
                        <small>{formatBytes(process.memoryBytes)}</small>
                      </span>
                      {process.killable.kind === "refused" ? (
                        <span className={styles.refused}>{process.killable.reason}</span>
                      ) : (
                        <button
                          className={
                            confirmPid === process.pid || pendingProcess?.pid === process.pid
                              ? styles.danger
                              : styles.quiet
                          }
                          type="button"
                          onClick={() => void signalProcess(process)}
                        >
                          {pendingProcess?.pid === process.pid
                            ? `Continue approved stop ${process.name}`
                            : confirmPid === process.pid
                              ? `Confirm stop ${process.name}`
                              : `Stop ${process.name}`}
                        </button>
                      )}
                    </li>
                  ))}
                  {!processBusy && !processes.length ? (
                    <p className={styles.muted}>No related processes were returned by the current sample.</p>
                  ) : null}
                </ul>
              </>
            ) : null}

            {active === "ports" ? (
              <>
                <Heading
                  eyebrow="System inventory"
                  title="Listening ports"
                  detail="A current bounded native snapshot; exposure reflects the bind address without guessing firewall policy."
                />
                <p className={styles.meta}>Source: {portSource ?? "probing"}</p>
                <div className={styles.portGrid}>
                  {ports.map((port) => (
                    <article key={`${port.protocol}-${port.localAddress}-${port.port}`}>
                      <strong>{port.port}</strong>
                      <span>{port.protocol.toUpperCase()}</span>
                      <p>{port.processName ?? "Unresolved owner"}</p>
                      <small>
                        {port.localAddress} · {port.exposure.replaceAll("_", " ")}
                      </small>
                    </article>
                  ))}
                </div>
                {!ports.length ? (
                  <p className={styles.muted}>No listening sockets were returned by the current probe.</p>
                ) : null}
              </>
            ) : null}

            {active === "environment" ? (
              <>
                <Heading
                  eyebrow="Protected values"
                  title="Environment viewer"
                  detail="Names and type hints appear first. Revealing a value uses native confirmation that the WebView cannot forge."
                />
                {environment?.note ? <p className={styles.meta}>{environment.note}</p> : null}
                <div className={styles.envList}>
                  {environment?.entries.map((entry) => (
                    <div key={entry.name}>
                      <code>{entry.name}</code>
                      <span>
                        {entry.kind} · {entry.hint}
                      </span>
                      <button
                        className={styles.quiet}
                        type="button"
                        onClick={() =>
                          void api
                            .envReveal(environment.source, entry.name)
                            .then(setRevealed, (failure) => setError(safeMessage(failure)))
                        }
                      >
                        Reveal
                      </button>
                    </div>
                  ))}
                </div>
                {revealed ? (
                  <div className={styles.secret} role="status">
                    <strong>{revealed.name}</strong>
                    <code>{revealed.value}</code>
                    <button type="button" className={styles.quiet} onClick={() => setRevealed(null)}>
                      Hide
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}

            {active === "sqlite" ? (
              <>
                <Heading
                  eyebrow="Governed data"
                  title="SQLite inspector"
                  detail="Open through the native picker. Reads are bounded; write statements stay separate and require deliberate confirmation."
                />
                <div className={styles.actions}>
                  <button
                    className={styles.primary}
                    type="button"
                    onClick={() => void api.sqlitePick().then(setDatabase, (failure) => setError(safeMessage(failure)))}
                  >
                    Choose database
                  </button>
                  {database ? (
                    <span className={styles.meta}>
                      {database.displayName} · {formatBytes(database.bytes)}
                    </span>
                  ) : null}
                </div>
                <label className={styles.field}>
                  <span>SQL statement</span>
                  <textarea
                    value={sql}
                    disabled={pendingSqlApproval !== null}
                    onChange={(event) => {
                      setSql(event.target.value);
                      setConfirmSql(false);
                    }}
                  />
                </label>
                <button
                  className={confirmSql || pendingSqlApproval ? styles.danger : styles.primary}
                  type="button"
                  disabled={!database}
                  onClick={() => void runSql()}
                >
                  {pendingSqlApproval
                    ? "Continue approved database change"
                    : confirmSql
                      ? "Confirm database change"
                      : "Run statement"}
                </button>
                {pendingSqlApproval ? (
                  <p className={styles.notice} role="status">
                    Approve this exact database change in Permissions, then continue it here. The SQL stays sealed in
                    the current native runtime.
                  </p>
                ) : null}
                {query ? (
                  <div className={styles.queryResult}>
                    <strong>
                      {query.rows.length} row{query.rows.length === 1 ? "" : "s"}
                    </strong>
                    <pre>{JSON.stringify(query.rows, null, 2)}</pre>
                  </div>
                ) : null}
              </>
            ) : null}

            {active === "regex" ? (
              <>
                <Heading
                  eyebrow="Bounded matching"
                  title="Regex lab"
                  detail="Rust's linear-time regex engine prevents catastrophic backtracking."
                />
                <label className={styles.field}>
                  <span>Pattern</span>
                  <input value={pattern} onChange={(event) => setPattern(event.target.value)} />
                </label>
                <label className={styles.field}>
                  <span>Test text</span>
                  <textarea value={regexText} onChange={(event) => setRegexText(event.target.value)} />
                </label>
                <button
                  className={styles.primary}
                  type="button"
                  onClick={() =>
                    void api.regex(pattern, regexText).then(
                      (result) =>
                        setRegexSummary(
                          result.error?.message ?? `${result.total} match${result.total === 1 ? "" : "es"}`,
                        ),
                      (failure) => setError(safeMessage(failure)),
                    )
                  }
                >
                  Run regex
                </button>
                {regexSummary ? (
                  <p className={styles.resultLine} role="status">
                    {regexSummary}
                  </p>
                ) : null}
              </>
            ) : null}

            {active === "notes" ? (
              <>
                <Heading
                  eyebrow="Local workspace"
                  title="Scratchpads"
                  detail="Short notes in the Utility store; deletion requires a deliberate second action."
                />
                <div className={styles.split}>
                  <div>
                    <label className={styles.field}>
                      <span>Title</span>
                      <input value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} />
                    </label>
                    <label className={styles.field}>
                      <span>Note</span>
                      <textarea value={noteContent} onChange={(event) => setNoteContent(event.target.value)} />
                    </label>
                    <button
                      className={styles.primary}
                      type="button"
                      disabled={!noteTitle.trim()}
                      onClick={() => void saveNote()}
                    >
                      Save note
                    </button>
                  </div>
                  <div className={styles.noteList}>
                    {notes.map((note) => (
                      <article key={note.id}>
                        <strong>{note.title}</strong>
                        <p>{note.content}</p>
                        <button
                          className={deleteNote === note.id ? styles.danger : styles.quiet}
                          type="button"
                          onClick={() => {
                            if (deleteNote !== note.id) {
                              setDeleteNote(note.id);
                              return;
                            }
                            void api.scratchpadDelete(note.id).then(
                              async () => {
                                setDeleteNote(null);
                                setNotes((await api.scratchpads(null)).items);
                              },
                              (failure) => setError(safeMessage(failure)),
                            );
                          }}
                        >
                          {deleteNote === note.id ? `Confirm delete ${note.title}` : `Delete ${note.title}`}
                        </button>
                      </article>
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {active === "scratch_terminal" ? (
              <>
                <Heading
                  eyebrow="Workspace authority"
                  title="Scratch terminal"
                  detail="A terminal opens through the workspace terminal authority, preserving shell selection, lifecycle tracking, and shutdown behavior."
                />
                <div className={styles.dependency}>
                  <span aria-hidden="true">›_</span>
                  <div>
                    <strong>
                      {openScratchTerminal ? "Terminal authority connected" : "Workspace integration required"}
                    </strong>
                    <p>
                      {openScratchTerminal
                        ? "Open a governed workspace terminal without exposing a command string to this surface."
                        : "This surface has no direct shell authority. Mount it with the workspace terminal callback to enable the action."}
                    </p>
                  </div>
                </div>
                {openScratchTerminal ? (
                  <button className={styles.primary} type="button" onClick={openScratchTerminal}>
                    Open scratch terminal
                  </button>
                ) : null}
              </>
            ) : null}
          </main>
        </div>
      </section>
    </Page>
  );
}
