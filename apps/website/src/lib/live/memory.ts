import type { MemoryCategory } from "@kalcode/protocol";

export const MEMORY_CATEGORIES: Record<MemoryCategory, string> = {
  project: "Project",
  decisions: "Decisions",
  architecture: "Architecture",
  conventions: "Conventions",
  product: "Product",
  recent_context: "Recent important context",
  known_issues: "Known issues",
};

export interface DemoMemoryNote {
  id: string;
  title: string;
  content: string;
  category: MemoryCategory;
  source: string;
  file: string;
  pinned: boolean;
  permanent: boolean;
  stale: boolean;
}

export interface DemoMemory {
  notes: DemoMemoryNote[];
  query: string;
  category: string;
  selected: string | null;
  draft: DemoMemoryNote | null;
  confirmRemove: boolean;
  sequence: number;
}

/** Fictional workspace knowledge. This demo never stores or sends entered content. */
export function initialMemory(): DemoMemory {
  return {
    query: "",
    category: "all",
    selected: "dashboard",
    draft: null,
    confirmRemove: false,
    sequence: 0,
    notes: [
      {
        id: "dashboard",
        title: "The dashboard shell",
        content:
          "Dashboard.tsx owns the main dashboard shell. Keep reusable stat cards in src/components/StatCard.tsx so the overview and reports use the same layout.",
        category: "architecture",
        source: "Coding agent · Claude A",
        file: "src/pages/Dashboard.tsx",
        pinned: true,
        permanent: false,
        stale: false,
      },
      {
        id: "releases",
        title: "Review before release",
        content:
          "Run pnpm typecheck and pnpm test before a release. Review the dashboard in Live Browser at desktop and phone widths.",
        category: "decisions",
        source: "You",
        file: "",
        pinned: true,
        permanent: true,
        stale: false,
      },
      {
        id: "styles",
        title: "Use the shared design tokens",
        content:
          "Use shared spacing and colour tokens for new components. Prefer the existing StatCard and empty-state patterns before introducing new variants.",
        category: "conventions",
        source: "Project instructions",
        file: "AGENTS.md",
        pinned: false,
        permanent: false,
        stale: false,
      },
      {
        id: "chart",
        title: "Chart labels on small screens",
        content:
          "Weekly revenue labels can overlap on narrow screens. Check the latest chart layout before changing the tick spacing.",
        category: "known_issues",
        source: "Coding agent · Codex A",
        file: "src/components/RevenueChart.tsx",
        pinned: false,
        permanent: false,
        stale: true,
      },
    ],
  };
}

export function visibleMemory(memory: DemoMemory): DemoMemoryNote[] {
  const query = memory.query.trim().toLocaleLowerCase();
  return memory.notes
    .filter(
      (note) =>
        (memory.category === "all" || note.category === memory.category) &&
        `${note.title} ${note.content} ${note.file}`.toLocaleLowerCase().includes(query),
    )
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

export function memoryAction(memory: DemoMemory, action: string, id: string): void {
  const note = memory.notes.find((entry) => entry.id === memory.selected);
  switch (action) {
    case "select":
      memory.selected = id;
      memory.draft = null;
      memory.confirmRemove = false;
      break;
    case "category":
      if (id === "all" || Object.hasOwn(MEMORY_CATEGORIES, id)) memory.category = id;
      break;
    case "new":
      memory.draft = {
        id: "",
        title: "",
        content: "",
        category: "project",
        source: "You",
        file: "",
        pinned: false,
        permanent: false,
        stale: false,
      };
      memory.confirmRemove = false;
      break;
    case "edit":
      if (note) memory.draft = { ...note };
      memory.confirmRemove = false;
      break;
    case "cancel":
      memory.draft = null;
      memory.confirmRemove = false;
      break;
    case "pin":
      if (note) note.pinned = !note.pinned;
      break;
    case "permanent":
      if (note) note.permanent = !note.permanent;
      break;
    case "review":
      if (note) note.stale = false;
      break;
    case "remove":
      memory.confirmRemove = true;
      break;
    case "confirm-remove":
      memory.notes = memory.notes.filter((entry) => entry.id !== memory.selected);
      memory.selected = visibleMemory(memory)[0]?.id ?? null;
      memory.confirmRemove = false;
      break;
    case "back":
      memory.selected = null;
      memory.draft = null;
      memory.confirmRemove = false;
      break;
  }
}

export function saveMemory(memory: DemoMemory): boolean {
  const draft = memory.draft;
  if (!draft?.title.trim() || !draft.content.trim()) return false;
  const existing = memory.notes.find((note) => note.id === draft.id);
  const changed =
    existing &&
    (existing.title !== draft.title || existing.content !== draft.content || existing.category !== draft.category);
  const saved = {
    ...draft,
    id: draft.id || `sample-${++memory.sequence}`,
    title: draft.title.trim(),
    content: draft.content.trim(),
    source: "You",
    stale: changed ? false : draft.stale,
  };
  memory.notes = [saved, ...memory.notes.filter((note) => note.id !== saved.id)];
  memory.selected = saved.id;
  memory.draft = null;
  memory.query = "";
  memory.category = "all";
  return true;
}

export function renderMemory(memory: DemoMemory, esc: (text: string | number) => string, available: boolean): string {
  const notes = visibleMemory(memory);
  const note = memory.notes.find((entry) => entry.id === memory.selected);
  const draft = memory.draft;
  const button = (action: string, label: string, extra = "") =>
    `<button type="button" class="lk-btn" data-do="memory-${action}" ${extra}>${label}</button>`;
  const categories = Object.entries(MEMORY_CATEGORIES);
  const options = (value: string) =>
    categories
      .map(([id, label]) => `<option value="${id}" ${id === value ? "selected" : ""}>${label}</option>`)
      .join("");
  let detail = `<div class="lk-memory__empty"><h3>Useful context, close at hand</h3><p>Select a memory to see its source and keep it up to date.</p></div>`;
  if (draft) {
    detail = `<form class="lk-memory__editor" data-form="memory"><h3>${draft.id ? "Edit memory" : "Add memory"}</h3>
      <label>Title<input data-key="memory-title" data-memory-field="title" aria-label="Memory title" value="${esc(draft.title)}" maxlength="160" required/></label>
      <label>Category<select data-memory-field="category" aria-label="Memory category">${options(draft.category)}</select></label>
      <label>What should KalCode remember?<textarea data-key="memory-content" data-memory-field="content" aria-label="Memory content" rows="6" maxlength="8000" required>${esc(draft.content)}</textarea></label>
      <div class="lk-memory__actions"><button type="submit" class="lk-btn lk-btn--primary">Save memory</button>${button("cancel", "Cancel")}</div>
    </form>`;
  } else if (note) {
    detail = `<article class="lk-memory__detail" aria-label="Memory details">
      <div class="lk-memory__eyebrow">${MEMORY_CATEGORIES[note.category]}${note.permanent ? " · Permanent" : ""}</div>
      <h3>${esc(note.title)}</h3><p class="lk-memory__content">${esc(note.content)}</p>
      ${note.stale ? `<aside class="lk-memory__stale"><strong>Review this memory</strong><p>The linked file changed in this sample. Confirm the note still applies or edit it.</p>${button("review", "Mark reviewed")}</aside>` : ""}
      <dl class="lk-memory__source"><dt>Source</dt><dd>${esc(note.source)}</dd>${note.file ? `<dt>Linked file</dt><dd>${esc(note.file)}</dd>` : ""}<dt>Workspace</dt><dd>sample-app</dd></dl>
      <div class="lk-memory__actions">${button("edit", "Edit memory")}${button("pin", note.pinned ? "Unpin" : "Pin", `aria-pressed="${note.pinned}"`)}${button("permanent", "Permanent", `aria-pressed="${note.permanent}"`)}${button("remove", "Remove")}</div>
      ${memory.confirmRemove ? `<div class="lk-memory__confirm" role="group" aria-label="Remove memory"><p>Remove “${esc(note.title)}” from this sample workspace?</p><div class="lk-memory__actions">${button("confirm-remove", "Remove memory")}${button("cancel", "Keep memory")}</div></div>` : ""}
    </article>`;
  }
  return `<section class="lk-memory" aria-label="Unified Memory" data-detail="${Boolean(note || draft)}">
    <header class="lk-memory__header"><div><p class="lk-memory__eyebrow">sample-app · Shared project knowledge</p><h2>Unified Memory ${available ? "" : '<span class="lk-soon">Coming soon</span>'}</h2><p>Your project, remembered. Across every agent and session.</p></div>${button("new", "Add memory", 'aria-label="Add memory"')}</header>
    <p class="lk-memory__sample">Fictional sample notes. Changes stay in this page and reset when you reload.</p>
    <div class="lk-memory__tools"><label>Search memory<input type="search" data-key="memory-query" data-memory-query aria-label="Search memory" value="${esc(memory.query)}" placeholder="Search decisions, files and context…" ${draft ? "disabled" : ""}/></label><label>Category<select data-memory-category aria-label="Filter memory category" ${draft ? "disabled" : ""}><option value="all">All categories</option>${options(memory.category)}</select></label></div>
    <div class="lk-memory__split"><div class="lk-memory__list" aria-label="Project memories">${notes.length ? notes.map((entry) => `<button type="button" class="lk-memory__note" data-do="memory-select:${entry.id}" aria-pressed="${entry.id === memory.selected}" aria-label="${esc(entry.title)}"><span class="lk-memory__eyebrow">${MEMORY_CATEGORIES[entry.category]}${entry.pinned ? " · Pinned" : ""}</span><strong>${esc(entry.title)}</strong><span>${esc(entry.content)}</span>${entry.stale ? "<small>Needs review</small>" : ""}</button>`).join("") : '<div class="lk-memory__empty"><h3>No memories found</h3><p>Try another search or add a useful project note.</p></div>'}</div><div class="lk-memory__panel"><button type="button" class="lk-btn lk-memory__back" data-do="memory-back">Back to memories</button>${detail}</div></div>
  </section>`;
}
