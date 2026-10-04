import type { MemoryCategory, MemoryInput, MemoryRecord, MemorySettings } from "@kalcode/protocol";
import { Button, IconButton } from "@kalcode/ui/components";
import {
  ArrowLeft,
  BrainCircuit,
  Check,
  FileText,
  FolderOpen,
  Pin,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { focusSection } from "../dashboard/useNow.ts";
import styles from "./UnifiedMemory.module.css";

const CATEGORIES: Record<MemoryCategory, string> = {
  project: "Project",
  decisions: "Decisions",
  architecture: "Architecture",
  conventions: "Conventions",
  product: "Product",
  recent_context: "Recent important context",
  known_issues: "Known issues",
};
const SOURCES = {
  user: "You",
  agent: "Coding agent",
  brainstorm: "Brainstorm",
  run: "Run",
  instructions: "Project instructions",
  handoff: "Agent handoff",
  merge: "Merged change",
};
const blank = (): MemoryInput => ({
  category: "project",
  title: "",
  content: "",
  pinned: false,
  permanent: false,
  sourceKind: "user",
  sourceId: null,
  filePath: null,
  commitId: null,
});

export function UnifiedMemory() {
  const { active, workspaces, activate, openFolder } = useWorkspaces();
  return (
    <section className={styles.surface} aria-label="Unified Memory">
      <header className={styles.header}>
        <div className={styles.heading}>
          <BrainCircuit size={25} aria-hidden="true" />
          <div>
            <h1>Unified Memory</h1>
            <p>Your project, remembered. Across every agent and session.</p>
          </div>
        </div>
        {active && (
          <label className={styles.workspace}>
            Workspace
            <select
              aria-label="Memory workspace"
              value={active.id}
              onChange={(event) => void activate(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      {active ? (
        <WorkspaceMemory key={active.id} workspaceId={active.id} name={active.name} />
      ) : (
        <div className={styles.empty}>
          <FolderOpen size={36} />
          <h2>A home for your project knowledge</h2>
          <p>Open a project to keep its decisions, conventions and useful context together.</p>
          <Button variant="primary" onClick={() => void openFolder()}>
            Open project
          </Button>
        </div>
      )}
    </section>
  );
}

function WorkspaceMemory({ workspaceId, name }: { workspaceId: string; name: string }) {
  const { client } = useRuntime();
  const { navigate } = useNavigation();
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [planRequired, setPlanRequired] = useState(false);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [category, setCategory] = useState<MemoryCategory | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<MemoryInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    // Explicit refresh invalidates the local snapshot without polling while editing.
    void revision;
    let cancelled = false;
    setSearching(true);
    setError("");
    const timer = window.setTimeout(
      () => {
        Promise.all([client.listUnifiedMemory(workspaceId, query), client.unifiedMemoryPreferences(workspaceId)])
          .then(([items, preferences]) => {
            if (cancelled) return;
            setRecords(items);
            setSettings(preferences);
            setLoaded(true);
            setSearching(false);
          })
          .catch((cause: unknown) => {
            if (!cancelled) {
              const failure = toKalCodeError(cause);
              setError(failure.message);
              setPlanRequired(failure.code === "memory_plan_required");
              setLoaded(true);
              setSearching(false);
            }
          });
      },
      query.trim() ? 120 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, workspaceId, revision, query]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible" && !draft && !saving && !searching) {
        setRevision((value) => value + 1);
      }
    };
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [draft, saving, searching]);

  const filtered = useMemo(() => {
    return records
      .filter((item) => category === "all" || item.category === category)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }, [records, category]);
  const current = records.find((item) => item.id === selected) ?? null;
  const staleCount = records.filter((item) => item.stale).length;

  async function save(input: MemoryInput, id: string | null) {
    setSaving(true);
    setError("");
    try {
      const saved = await client.saveUnifiedMemory(workspaceId, id, input);
      if (!live.current) return;
      setRecords((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setSelected(saved.id);
      setDraft(null);
      setNotice("Memory saved.");
    } catch (cause) {
      if (live.current) setError(toKalCodeError(cause).message);
    } finally {
      if (live.current) setSaving(false);
    }
  }
  async function review() {
    if (!current || draft) return;
    setSaving(true);
    setError("");
    try {
      const reviewed = await client.reviewUnifiedMemory(workspaceId, current.id);
      if (!live.current) return;
      setRecords((items) => items.map((item) => (item.id === reviewed.id ? reviewed : item)));
      setNotice(
        reviewed.stale
          ? "The source still could not be verified. This memory needs review."
          : "Memory reviewed. Source verification updated.",
      );
    } catch (cause) {
      if (live.current) setError(toKalCodeError(cause).message);
    } finally {
      if (live.current) setSaving(false);
    }
  }
  async function remove() {
    if (!current) return;
    setSaving(true);
    setError("");
    try {
      await client.deleteUnifiedMemory(workspaceId, current.id);
      if (!live.current) return;
      setRecords((items) => items.filter((item) => item.id !== current.id));
      setSelected(null);
      setConfirmDelete(false);
      setNotice("Memory removed.");
    } catch (cause) {
      if (live.current) setError(toKalCodeError(cause).message);
    } finally {
      if (live.current) setSaving(false);
    }
  }
  async function preferences(next: MemorySettings) {
    setSaving(true);
    setError("");
    try {
      const saved = await client.setUnifiedMemoryPreferences(workspaceId, next);
      if (live.current) {
        setSettings(saved);
        setNotice("Memory preferences saved.");
      }
    } catch (cause) {
      if (live.current) setError(toKalCodeError(cause).message);
    } finally {
      if (live.current) setSaving(false);
    }
  }
  function select(id: string | null) {
    setSelected(id);
    setDraft(null);
    setConfirmDelete(false);
  }
  if (planRequired)
    return (
      <div className={styles.empty}>
        <BrainCircuit size={36} />
        <h2>Your project knowledge, together</h2>
        <p>{error}</p>
        <p>Keep decisions, conventions and useful context across agents, providers and sessions.</p>
        <Button
          variant="primary"
          onClick={() => {
            navigate("settings");
            requestAnimationFrame(() => requestAnimationFrame(() => focusSection("kalcode-account")));
          }}
        >
          View plans
        </Button>
      </div>
    );
  return (
    <>
      <div className={styles.controls}>
        <label className={styles.search}>
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="Search project memory"
            disabled={!!draft || saving}
            placeholder="Search decisions, files, conventions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <IconButton
          label="Refresh memory"
          icon={<RefreshCw size={16} />}
          disabled={saving || searching || !!draft || !loaded}
          onClick={() => setRevision((value) => value + 1)}
        />
        <Button
          variant="primary"
          icon={<Plus size={16} />}
          disabled={saving || searching || !!draft || !loaded}
          onClick={() => {
            select(null);
            setDraft(blank());
          }}
        >
          Remember something
        </Button>
      </div>
      <nav className={styles.categories} aria-label="Memory categories">
        {(["all", ...Object.keys(CATEGORIES)] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={category === value}
            onClick={() => setCategory(value as MemoryCategory | "all")}
          >
            {value === "all" ? "All memories" : CATEGORIES[value as MemoryCategory]}
            <span>{records.filter((item) => value === "all" || item.category === value).length}</span>
          </button>
        ))}
      </nav>
      {error && (
        <div className={styles.error} role="alert">
          {error}
          <Button size="sm" onClick={() => setRevision((value) => value + 1)}>
            Retry loading
          </Button>
        </div>
      )}
      <div className={styles.body} data-detail={!!draft || !!current}>
        <div className={styles.collection}>
          <div className={styles.collectionHeading}>
            <span>{name}</span>
            <span aria-live="polite">
              {searching ? (
                "Searching…"
              ) : (
                <>
                  {filtered.length} {filtered.length === 1 ? "memory" : "memories"}
                </>
              )}
            </span>
          </div>
          {!loaded ? (
            <div className={styles.skeleton} role="status" aria-label="Loading project memory">
              <span />
              <span />
              <span />
            </div>
          ) : filtered.length ? (
            <ul className={styles.list} aria-label="Project memories">
              {filtered.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={!!draft || saving || searching}
                    aria-pressed={selected === item.id}
                    onClick={() => select(item.id)}
                  >
                    <span className={styles.rowMeta}>
                      <span>{CATEGORIES[item.category]}</span>
                      {item.pinned && <Pin size={13} aria-label="Pinned" />}
                      {item.permanent && <span>Permanent</span>}
                      {item.stale && <span className={styles.warning}>Needs review</span>}
                    </span>
                    <strong>{item.title}</strong>
                    <span className={styles.preview}>{item.content}</span>
                    <span className={styles.origin}>
                      {SOURCES[item.sourceKind]}
                      {item.filePath ? ` · ${item.filePath}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.listEmpty}>
              <BrainCircuit size={28} />
              <h2>
                {records.length || query || category !== "all" ? "No matching memories" : "Start with what matters"}
              </h2>
              <p>
                {records.length || query || category !== "all"
                  ? "Try another search or category."
                  : "Architecture, decisions, useful commands. Keep the context your next agent should know."}
              </p>
            </div>
          )}
        </div>
        <section className={styles.detail} aria-label={draft ? "Memory editor" : "Memory details"}>
          {draft ? (
            <form
              className={styles.editor}
              onSubmit={(event) => {
                event.preventDefault();
                void save({ ...draft, sourceKind: "user" }, selected);
              }}
            >
              <div className={styles.detailTop}>
                <h2>{selected ? "Edit memory" : "Remember something"}</h2>
                <Button size="sm" disabled={saving || searching} onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </div>
              <label>
                Title
                <input
                  required
                  maxLength={160}
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                  placeholder="What should this project remember?"
                />
              </label>
              <label>
                Category
                <select
                  value={draft.category}
                  onChange={(event) => setDraft({ ...draft, category: event.target.value as MemoryCategory })}
                >
                  {Object.entries(CATEGORIES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Knowledge
                <textarea
                  required
                  maxLength={8000}
                  rows={8}
                  value={draft.content}
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                  placeholder="Write a concise fact, decision or convention. Include why it matters."
                />
              </label>
              <label>
                Related file <span className={styles.optional}>(optional, relative to project)</span>
                <input
                  value={draft.filePath ?? ""}
                  onChange={(event) => setDraft({ ...draft, filePath: event.target.value || null })}
                  placeholder="src/Dashboard.tsx"
                />
              </label>
              <div className={styles.checks}>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.pinned}
                    onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })}
                  />
                  Pin important context
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.permanent}
                    onChange={(event) => setDraft({ ...draft, permanent: event.target.checked })}
                  />
                  Keep permanently
                </label>
              </div>
              <p className={styles.hint}>
                Keep secrets and credentials out of project memory. Related files help KalCode detect outdated context.
              </p>
              <Button
                type="submit"
                variant="primary"
                busy={saving}
                disabled={!draft.title.trim() || !draft.content.trim()}
                icon={<Check size={16} />}
              >
                Save memory
              </Button>
            </form>
          ) : current ? (
            <>
              <div className={styles.detailTop}>
                <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} />} onClick={() => select(null)}>
                  All memories
                </Button>
                <Button
                  size="sm"
                  disabled={saving || searching}
                  onClick={() => {
                    setConfirmDelete(false);
                    setDraft({ ...current });
                  }}
                >
                  Edit
                </Button>
              </div>
              <div className={styles.reading} data-selectable>
                <span className={styles.category}>{CATEGORIES[current.category]}</span>
                <h2>{current.title}</h2>
                {current.stale && (
                  <div className={styles.stale}>
                    <p>
                      {current.filePath
                        ? "The related file changed or could not be verified. Check the source, then edit outdated knowledge or mark this memory reviewed."
                        : "This memory has not been reviewed recently. Check that the knowledge is still current, then edit it or mark it reviewed."}
                    </p>
                    <p id="memory-review-help">
                      {current.filePath
                        ? "Mark reviewed rechecks the linked file and records your confirmation that this knowledge is still current."
                        : "Mark reviewed records your confirmation that this knowledge is still current."}
                    </p>
                    <Button
                      size="sm"
                      disabled={saving || searching || !!draft}
                      aria-describedby="memory-review-help"
                      icon={<Check size={14} />}
                      onClick={() => void review()}
                    >
                      Mark reviewed
                    </Button>
                  </div>
                )}
                <p className={styles.content}>{current.content}</p>
              </div>
              <div className={styles.detailActions}>
                <Button
                  size="sm"
                  aria-pressed={current.pinned}
                  disabled={saving || searching}
                  icon={<Pin size={14} />}
                  onClick={() => void save({ ...current, pinned: !current.pinned }, current.id)}
                >
                  {current.pinned ? "Pinned" : "Pin"}
                </Button>
                <Button
                  size="sm"
                  aria-pressed={current.permanent}
                  disabled={saving || searching}
                  onClick={() => void save({ ...current, permanent: !current.permanent }, current.id)}
                >
                  {current.permanent ? "Permanent" : "Keep permanently"}
                </Button>
              </div>
              <dl className={styles.provenance}>
                <dt>Remembered from</dt>
                <dd>
                  {SOURCES[current.sourceKind]}
                  {current.sourceId && <span>{current.sourceId}</span>}
                </dd>
                {current.filePath && (
                  <>
                    <dt>Related file</dt>
                    <dd>
                      <FileText size={13} />
                      {current.filePath}
                    </dd>
                  </>
                )}
                {current.commitId && (
                  <>
                    <dt>Commit</dt>
                    <dd>{current.commitId}</dd>
                  </>
                )}
                <dt>Last updated</dt>
                <dd>{new Date(current.updatedAt).toLocaleString()}</dd>
              </dl>
              <div className={styles.delete}>
                {confirmDelete ? (
                  <>
                    <p>Remove this memory from {name}? Agents will no longer receive it.</p>
                    <Button variant="danger" size="sm" busy={saving} onClick={() => void remove()}>
                      Remove memory
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={saving || searching}
                      onClick={() => setConfirmDelete(false)}
                    >
                      Keep memory
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={saving || searching}
                    icon={<Trash2 size={14} />}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className={styles.welcome}>
              <BrainCircuit size={40} aria-hidden="true" />
              <h2>
                One project.
                <br />
                Shared understanding.
              </h2>
              <p>Useful knowledge travels with your workspace, so each new agent has somewhere to start.</p>
              <div className={styles.sharedWith}>
                Coding agents <span>·</span> KalVoice
              </div>
              <p className={styles.hint}>
                {records.length
                  ? "Select a memory to inspect its source, update it or make it permanent."
                  : "Add your first memory, or let KalCode capture explicit decisions and project instructions as you work."}
              </p>
              {staleCount > 0 && (
                <p className={styles.warning}>
                  {staleCount} {staleCount === 1 ? "memory needs" : "memories need"} a source review.
                </p>
              )}
            </div>
          )}
        </section>
      </div>
      <footer className={styles.footer}>
        <span>
          <ShieldCheck size={15} />
          Saved on this device
          {settings
            ? settings.sharingEnabled
              ? " · Relevant context shared with your agents"
              : " · Agent sharing paused"
            : ""}
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showPreferences}
          onClick={() => setShowPreferences((value) => !value)}
        >
          Memory preferences
        </Button>
      </footer>
      {showPreferences && settings && (
        <div className={styles.preferences}>
          <label>
            <input
              type="checkbox"
              disabled={saving || searching}
              checked={settings.autoCapture}
              onChange={(event) => void preferences({ ...settings, autoCapture: event.target.checked })}
            />
            <span>
              Automatically remember useful context
              <small>Conservative capture of explicit decisions, outcomes and project instructions.</small>
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              disabled={saving || searching}
              checked={settings.sharingEnabled}
              onChange={(event) => void preferences({ ...settings, sharingEnabled: event.target.checked })}
            />
            <span>
              Share relevant memory with agents and KalVoice
              <small>Selected context is sent to the provider you use for that task.</small>
            </span>
          </label>
        </div>
      )}
      <span className={styles.srOnly} role="status">
        {notice}
      </span>
    </>
  );
}
