/**
 * Stage controller for one drawn KalCode window (AppWindow) or a still made of its parts.
 *
 * The HTML is complete at build time; this only flips state attributes, streams transcript
 * lines, and runs short scripted sequences (approval arrives and is approved, KalVoice
 * dictation, a voice command that opens threads, a mission). Timers pause while the window is
 * offscreen or the tab is hidden; reduced motion skips straight to the end state.
 */
import {
  type ApprovalState,
  type DockTab,
  MISSION,
  MODES,
  type PermissionMode,
  type ProviderId,
  type Scene,
  STATUS,
  summarize,
  summaryLead,
  type ThreadStatus,
  VOICE,
  type VoiceState,
  ZOD_APPROVAL,
} from "../../data/story";
import {
  announce,
  fitLog,
  formatElapsed,
  qsa,
  reducedMotion,
  roving,
  Scheduler,
  setTabStop,
  watchLogs,
  watchVisibility,
  whenNear,
} from "./util";

export type Play = "reveal" | "approve" | "dictate" | "command" | "mission";

const DEFAULT_THREAD: Record<Exclude<ProviderId, "shell">, string> = {
  claude: "claude-checkout",
  codex: "codex-signup",
  gemini: "gemini-research",
};

const PROVIDER_NAME: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  shell: "PowerShell",
};

const VOICE_LABEL: Record<VoiceState, string> = {
  off: "Ready",
  listening: "Listening",
  processing: "Processing",
  executing: "Executing",
  approval: "Needs Approval",
  done: "Done",
  spawned: "Done",
  error: "Error",
};

const MAX_PANES = 4;

function readScene(root: HTMLElement): Scene {
  const d = root.dataset;
  return {
    view: d.view === "dashboard" ? "dashboard" : "code",
    panes: (d.panes ?? "").split(" ").filter(Boolean),
    focus: d.focus ?? "",
    layout: d.layout === "cols" ? "cols" : "rows",
    dock: (d.dock as DockTab) ?? "none",
    approval: (d.approval as ApprovalState) ?? "none",
    voice: (d.voice as VoiceState) ?? "off",
    mission: Number(d.mission ?? 0),
    mode: (d.mode as PermissionMode) ?? "approve",
  };
}

export class StageApp {
  readonly root: HTMLElement;
  readonly interactive: boolean;
  state: Scene;
  private readonly initial: Scene;
  private readonly sched = new Scheduler();
  private readonly live: Element | null;
  private visible = false;
  private tick: number | undefined;
  private wave: number | undefined;
  private recent: string[] = [];
  private present = new Set<string>();
  private created = 0;
  private hold: { start: number; released: boolean; say: "dictation" | "command" } | null = null;
  private lastSpawn: string[] = [];

  constructor(root: HTMLElement) {
    this.root = root;
    this.interactive = root.dataset.interactive === "true";
    this.state = readScene(root);
    this.initial = { ...this.state, panes: [...this.state.panes] };
    this.live = root.querySelector("[data-kc-live]");
    this.recent = [this.state.focus];
    for (const id of VOICE.spawns) if (!this.row(id)?.hidden) this.present.add(id);

    if (this.interactive) this.bindEvents();
    watchVisibility(root, (visible) => this.setVisible(visible));
    // Transcripts refit whenever their box changes (fonts, splits, docks, the mission strip).
    watchLogs(root);
  }

  /* ------------------------------------------------------------ queries */

  private panes(): HTMLElement[] {
    return qsa(this.root, ".kc-pane[data-thread]");
  }

  /** A thread's pane, created from its template the first time it is needed. */
  pane(id: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`.kc-pane[data-thread="${id}"]`) ?? this.materialize(id);
  }

  private materialize(id: string): HTMLElement | null {
    const tpl = this.root.querySelector<HTMLTemplateElement>(`template[data-kc-pane-tpl="${id}"]`);
    const el = tpl?.content.firstElementChild?.cloneNode(true) as HTMLElement | undefined;
    if (!tpl || !el) return null;
    tpl.replaceWith(el);
    watchLogs(el);
    for (const line of qsa(el, "[data-when]"))
      line.hidden = !(line.dataset.when ?? "").split(" ").includes(this.state.approval);
    const by = el.dataset.statusBy;
    if (by) {
      const map = Object.fromEntries(by.split(" ").map((pair) => pair.split(":") as [string, string]));
      const status = map[this.state.approval] as ThreadStatus | undefined;
      if (status) for (const label of qsa(el, "[data-kc-status-for]")) this.paintStatus(label, status, false);
    }
    return el;
  }

  /** Dock panels that are not shown at first wait in a template too. */
  private materializePanel(panel: Element | null): void {
    const tpl = panel?.querySelector<HTMLTemplateElement>(":scope > template[data-kc-lazy]");
    if (!panel || !tpl) return;
    tpl.replaceWith(tpl.content.cloneNode(true));
    if (this.interactive) {
      for (const group of qsa(panel, ".kc-perms__modes")) {
        roving(group, ".kc-mode", {
          orientation: "both",
          select: (el) => {
            this.setMode(el.dataset.kcMode as PermissionMode);
            this.say(`${MODES.find((m) => m.id === el.dataset.kcMode)?.label} mode selected.`);
          },
        });
      }
    }
    this.setMode(this.state.mode);
    this.paintApprovalCards(false);
  }

  /** Every thread this window knows: open panes and templated ones (without creating them). */
  private threadSources(): HTMLElement[] {
    return qsa(this.root, ".kc-pane[data-thread], template[data-kc-pane-tpl]");
  }

  private row(id: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`[data-kc-row="${id}"]`);
  }

  private providerOf(id: string): ProviderId {
    const source =
      this.root.querySelector<HTMLElement>(`.kc-pane[data-thread="${id}"]`) ??
      this.root.querySelector<HTMLElement>(`template[data-kc-pane-tpl="${id}"]`);
    return (source?.dataset.provider as ProviderId) ?? "claude";
  }

  private emit(): void {
    this.root.dispatchEvent(new CustomEvent("kc:state", { detail: this.state }));
  }

  say(text: string): void {
    announce(this.live, text);
  }

  /* ------------------------------------------------------------ visibility + clocks */

  private setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.root.removeAttribute("data-paused");
      this.sched.resume();
      this.startTick();
    } else {
      this.root.setAttribute("data-paused", "true");
      this.sched.pause();
      this.stopTick();
    }
  }

  private startTick(): void {
    if (this.tick !== undefined || reducedMotion()) return;
    this.tick = window.setInterval(() => {
      for (const el of qsa(this.root, ".kc-pane[data-open='true'] [data-kc-elapsed]")) {
        if (el.closest("[hidden]")) continue;
        const next = Number(el.dataset.kcElapsed ?? 0) + 1;
        el.dataset.kcElapsed = String(next);
        el.textContent = formatElapsed(next);
      }
    }, 1000);
  }

  private stopTick(): void {
    window.clearInterval(this.tick);
    this.tick = undefined;
  }

  /* ------------------------------------------------------------ scenes */

  /** Moves the window to `next`. With `animate`, changes are shown as they happen; `play` runs a sequence. */
  apply(next: Partial<Scene>, options: { animate?: boolean; play?: Play } = {}): void {
    const animate = Boolean(options.animate) && !reducedMotion();
    const play = reducedMotion() ? undefined : options.play;
    this.sched.cancel();
    this.stopWave();
    for (const card of qsa(this.root, ".kc-approval[data-just]")) card.removeAttribute("data-just");
    const prev = this.state;
    const s: Scene = { ...prev, ...next };

    let panes = [...s.panes];
    if (play === "command")
      panes = panes.filter((id) => !(VOICE.spawns as readonly string[]).includes(id) || this.isOpen(id, prev));

    for (const id of panes) if ((VOICE.spawns as readonly string[]).includes(id)) this.setPresent(id, true);
    if ((s.voice === "spawned" && play !== "command") || s.mission > 0)
      for (const id of VOICE.spawns) this.setPresent(id, true);
    if (!animate && s.voice !== "spawned" && s.mission === 0)
      for (const id of VOICE.spawns) if (!panes.includes(id)) this.setPresent(id, false);

    const opened = panes.filter((id) => !prev.panes.includes(id));
    this.setView(s.view);
    this.setLayout(s.layout);
    this.setPanes(panes, animate);
    this.setFocus(panes.includes(s.focus) ? s.focus : (panes[0] ?? ""), { scroll: false });
    this.setDock(s.dock, animate && s.dock !== prev.dock);
    this.setMode(s.mode);

    if (play === "approve") {
      this.setApproval("pending", { animate: true });
      this.sched.after(1500, () => {
        const btn =
          this.root.querySelector<HTMLElement>(
            ".kc-dock__panel:not([hidden]) .kc-approval[data-approval-id='zod'] [data-kc-decide='approved']",
          ) ?? this.root.querySelector<HTMLElement>(".kc-approval[data-approval-id='zod'] [data-kc-decide='approved']");
        btn?.classList.add("is-pressed");
        this.sched.after(260, () => {
          btn?.classList.remove("is-pressed");
          for (const c of qsa(this.root, ".kc-dash .kc-approval[data-approval-id='zod']")) {
            c.setAttribute("data-just", "");
            window.setTimeout(() => c.removeAttribute("data-just"), 2600);
          }
          this.setApproval("approved", { animate: true });
        });
      });
    } else {
      this.setApproval(s.approval, { animate: animate && s.approval !== prev.approval });
    }

    if (play === "dictate") {
      this.resetInputs();
      this.setVoice("off");
      this.sched.after(350, () => this.dictate());
    } else if (play === "command") {
      this.setVoice("off");
      this.sched.after(300, () => this.command());
    } else {
      if (s.voice !== "done") this.resetInputs();
      this.setVoice(s.voice, s.voice === "spawned" ? { text: VOICE.command } : {});
    }

    if (play === "mission") {
      this.setMission(0);
      this.sched.after(250, () => this.runMission());
    } else {
      this.setMission(s.mission);
    }

    if (play === "reveal") {
      const targets = opened.length ? opened : [this.state.focus];
      for (const id of targets) {
        const el = this.pane(id);
        if (el) this.reveal(el);
      }
    } else if (animate) {
      for (const id of opened) {
        const el = this.pane(id);
        if (el) this.reveal(el);
      }
    }

    if (animate && s.dock === "browser" && prev.dock !== "browser") this.toast();
    this.pinLogs();
    this.emit();
  }

  private isOpen(id: string, scene: Scene): boolean {
    return scene.panes.includes(id);
  }

  reset(): void {
    for (const el of qsa(this.root, "[data-kc-created]")) el.remove();
    this.created = 0;
    this.present.clear();
    this.apply({ ...this.initial }, { animate: false });
    this.say("Preview reset.");
  }

  /* ------------------------------------------------------------ panes */

  private setLayout(layout: Scene["layout"]): void {
    this.state.layout = layout;
    this.root.dataset.layout = layout;
  }

  private setPanes(ids: string[], animate: boolean): void {
    const before = new Set(this.state.panes);
    const list = ids.slice(0, MAX_PANES);
    for (const id of list) this.pane(id);
    for (const el of this.panes()) {
      const id = el.dataset.thread ?? "";
      const index = list.indexOf(id);
      el.dataset.open = index >= 0 ? "true" : "false";
      el.dataset.slot = String(Math.max(0, index));
      if (index >= 0 && !before.has(id) && animate) {
        el.setAttribute("data-enter", "");
        window.setTimeout(() => el.removeAttribute("data-enter"), 400);
      }
    }
    for (const tab of qsa(this.root, "[data-kc-mtab]")) {
      const key = tab.dataset.kcMtab ?? "";
      if (!key.startsWith("dock:")) tab.hidden = !list.includes(key);
    }
    this.state.panes = list;
    this.root.dataset.count = String(list.length);
    this.root.dataset.panes = list.join(" ");
  }

  private setPresent(id: string, present: boolean): void {
    if (present) this.present.add(id);
    else this.present.delete(id);
    const railItem = this.root.querySelector<HTMLElement>(`[data-kc-rail-thread="${id}"]`);
    if (railItem) railItem.hidden = !present;
    const row = this.row(id);
    if (row) row.hidden = !present;
  }

  /** Opens a thread's pane (evicting the least recently focused one past four) and focuses it. */
  open(id: string, options: { animate?: boolean; reveal?: boolean } = {}): void {
    const animate = options.animate ?? true;
    if (this.state.view === "dashboard") this.setView("code");
    if (!this.state.panes.includes(id)) {
      let next = [...this.state.panes, id];
      while (next.length > MAX_PANES) {
        const victim =
          this.recent
            .slice()
            .reverse()
            .find((p) => next.includes(p) && p !== id) ?? next[0];
        next = next.filter((p) => p !== victim);
      }
      const order = this.state.panes.filter((p) => next.includes(p));
      order.push(id);
      this.setPanes(order, animate && !reducedMotion());
      const el = this.pane(id);
      if (el && (options.reveal ?? animate)) this.reveal(el);
    }
    this.setFocus(id, { scroll: true });
    this.pinLogs();
    this.emit();
  }

  setFocus(id: string, options: { scroll?: boolean } = {}): void {
    if (!id) return;
    this.state.focus = id;
    this.root.dataset.focus = id;
    this.recent = [id, ...this.recent.filter((r) => r !== id)];
    for (const el of this.panes()) {
      if (el.dataset.thread === id) el.dataset.focus = "true";
      else el.removeAttribute("data-focus");
    }
    for (const el of qsa(this.root, ".kc-rail__thread")) {
      const on = el.dataset.thread === id;
      if (on) el.dataset.current = "true";
      else el.removeAttribute("data-current");
      if (el.tagName === "BUTTON") {
        if (on) el.setAttribute("aria-current", "true");
        else el.removeAttribute("aria-current");
      }
    }
    this.syncMobileTabs();
    if (options.scroll && this.isPhoneLayout())
      this.pane(id)?.scrollIntoView({
        block: "nearest",
        inline: "start",
        behavior: reducedMotion() ? "auto" : "smooth",
      });
  }

  private syncMobileTabs(): void {
    const key = this.mobileKey ?? this.state.focus;
    const tabs = qsa(this.root, "[data-kc-mtab]");
    for (const tab of tabs) {
      const on = tab.dataset.kcMtab === key;
      if (tab.tagName === "BUTTON") tab.setAttribute("aria-selected", on ? "true" : "false");
      else if (on) tab.dataset.selected = "true";
      else tab.removeAttribute("data-selected");
    }
    if (this.interactive)
      setTabStop(
        tabs.filter((t) => !t.hidden),
        tabs.find((t) => t.dataset.kcMtab === key) ?? null,
      );
  }

  private mobileKey: string | undefined;

  private isPhoneLayout(): boolean {
    const main = this.root.querySelector<HTMLElement>("[data-kc-main]");
    return main ? getComputedStyle(main).display === "flex" : false;
  }

  close(id: string): void {
    if (this.state.panes.length <= 1) {
      this.say("Keep at least one pane open.");
      return;
    }
    const next = this.state.panes.filter((p) => p !== id);
    this.setPanes(next, false);
    const focus = this.recent.find((r) => next.includes(r)) ?? next[0] ?? "";
    this.setFocus(focus);
    this.pane(focus)?.querySelector<HTMLElement>(".kc-pane__title")?.focus();
    this.say(
      `Closed the ${PROVIDER_NAME[this.providerOf(id)]} pane. The thread keeps running; reopen it from the rail or the Dashboard.`,
    );
    this.pinLogs();
    this.emit();
  }

  split(): void {
    if (this.state.view === "dashboard") this.setView("code");
    if (this.state.panes.length === 1) {
      const candidates = ["codex-signup", "gemini-research", "claude-checkout"].filter(
        (c) => !this.state.panes.includes(c),
      );
      const id = candidates[0];
      if (id) {
        this.open(id);
        this.say(`Split: ${PROVIDER_NAME[this.providerOf(id)]} opened below.`);
      }
      return;
    }
    const layout = this.state.layout === "rows" ? "cols" : "rows";
    this.setLayout(layout);
    this.say(layout === "cols" ? "Panes side by side." : "Panes stacked.");
    this.pinLogs();
    this.emit();
  }

  /** Focuses (or opens) the thread for a provider. */
  openProvider(provider: Exclude<ProviderId, "shell">): void {
    const openOne = this.state.panes.find((id) => this.providerOf(id) === provider);
    const id = openOne ?? DEFAULT_THREAD[provider];
    const already = this.state.panes.includes(id);
    this.open(id);
    this.say(`${PROVIDER_NAME[provider]} pane ${already ? "focused" : "opened"}.`);
  }

  /** "+ New thread": a fresh pane for the focused pane's provider. */
  newThread(provider?: Exclude<ProviderId, "shell">): string | null {
    const focused = this.providerOf(this.state.focus);
    const p = provider ?? (focused === "shell" ? "claude" : focused);
    const template = this.root.querySelector<HTMLTemplateElement>(`template[data-kc-fresh="${p}"]`);
    const grid = this.root.querySelector(".kc-grid");
    if (!template || !grid) return null;
    this.created += 1;
    const id = `new-${this.created}`;
    const name = this.created === 1 ? "New thread" : `New thread ${this.created}`;

    const pane = template.content.firstElementChild?.cloneNode(true) as HTMLElement | undefined;
    if (!pane) return null;
    pane.dataset.thread = id;
    pane.dataset.kcCreated = "true";
    watchLogs(pane);
    pane.dataset.testid = `pane-${id}`;
    pane.setAttribute("aria-label", `${PROVIDER_NAME[p]} · ${name}`);
    for (const el of qsa(pane, "[data-thread]")) el.dataset.thread = id;
    const nameEl = pane.querySelector("[data-kc-name]");
    if (nameEl) nameEl.textContent = `· ${name}`;
    const title = pane.querySelector(".kc-pane__title");
    title?.setAttribute("aria-label", `Focus ${PROVIDER_NAME[p]} · ${name}`);
    pane
      .querySelector(".kc-pane__ctl [data-kc-action='close']")
      ?.setAttribute("aria-label", `Close ${PROVIDER_NAME[p]} · ${name} pane`);
    for (const el of qsa(pane, "[data-kc-status-for]")) el.dataset.kcStatusFor = id;
    grid.append(pane);

    // Rail entry, Dashboard row and phone tab: copies of an existing one for the same provider.
    const source = DEFAULT_THREAD[p];
    const railSource = this.root.querySelector<HTMLElement>(`[data-kc-rail-thread="${source}"]`);
    if (railSource) {
      const rail = railSource.cloneNode(true) as HTMLElement;
      rail.dataset.kcRailThread = id;
      rail.dataset.kcCreated = "true";
      rail.hidden = false;
      for (const el of qsa(rail, "[data-thread]")) el.dataset.thread = id;
      const tname = rail.querySelector(".kc-rail__tname");
      if (tname) tname.innerHTML = `<span class="visually-hidden">${PROVIDER_NAME[p]}: </span>`;
      tname?.append(name);
      for (const el of qsa(rail, "[data-kc-status-for]")) el.dataset.kcStatusFor = id;
      railSource.parentElement?.append(rail);
    }
    const rowSource = this.row(source);
    if (rowSource) {
      const row = rowSource.cloneNode(true) as HTMLElement;
      row.dataset.kcRow = id;
      row.dataset.kcCreated = "true";
      row.dataset.testid = `row-${id}`;
      row.hidden = false;
      for (const el of qsa(row, "[data-thread]")) el.dataset.thread = id;
      const rname = row.querySelector(".kc-row__name");
      if (rname) rname.textContent = name;
      const act = row.querySelector<HTMLElement>(".kc-row__act");
      if (act) {
        act.textContent = "Waiting for your first message";
        act.removeAttribute("data-activity-by");
        act.dataset.kcActivityFor = id;
      }
      const dur = row.querySelector(".kc-row__dur");
      if (dur) dur.textContent = "under 1 min";
      const btn = row.querySelector(".kc-row__btn");
      btn?.setAttribute("aria-label", `${PROVIDER_NAME[p]}, ${name}. Focus its terminal`);
      for (const el of qsa(row, "[data-kc-status-for]")) el.dataset.kcStatusFor = id;
      rowSource.parentElement?.append(row);
    }
    const tabSource = this.root.querySelector<HTMLElement>(`[data-kc-mtab="${source}"]`);
    if (tabSource) {
      const tab = tabSource.cloneNode(true) as HTMLElement;
      tab.dataset.kcMtab = id;
      tab.dataset.kcCreated = "true";
      tabSource.parentElement?.insertBefore(tab, this.root.querySelector("[data-kc-mtab^='dock:']"));
    }
    for (const el of qsa(this.root, `[data-kc-status-for="${id}"]`)) this.paintStatus(el, "idle", false);
    this.open(id);
    this.refreshSummary();
    this.say(`New ${PROVIDER_NAME[p]} thread opened in atlas-api.`);
    return id;
  }

  /* ------------------------------------------------------------ transcript streaming */

  private pinLogs(): void {
    for (const log of qsa(this.root, ".kc-pane[data-open='true'] [data-kc-log], .kc-pane--still [data-kc-log]"))
      fitLog(log);
  }

  /** Streams a pane's transcript in, line by line, with short pauses before tool calls. */
  reveal(pane: HTMLElement): void {
    const log = pane.querySelector<HTMLElement>("[data-kc-log]");
    if (!log || reducedMotion()) return;
    const lines = qsa(log, ":scope > .kc-ln").filter((l) => !l.hidden);
    for (const l of lines) {
      l.removeAttribute("data-in");
      l.setAttribute("data-pending", "");
    }
    let i = 0;
    const step = () => {
      const line = lines[i++];
      if (!line) return;
      line.removeAttribute("data-pending");
      line.setAttribute("data-in", "");
      fitLog(log);
      const next = lines[i];
      if (!next) return;
      const c = next.classList;
      const delay =
        c.contains("kc-cl-tool") || c.contains("kc-cx-item") || c.contains("kc-gm-box")
          ? 300
          : c.contains("kc-diff")
            ? 200
            : c.contains("kc-cl-say") || c.contains("kc-cx-say") || c.contains("kc-gm-say")
              ? 380
              : c.contains("kc-cl-work") || c.contains("kc-cx-work") || c.contains("kc-gm-work")
                ? 420
                : 45;
      this.sched.after(delay, step);
    };
    step();
  }

  /** Reveals a still's lines again (tap-to-play on phones). */
  replay(): void {
    for (const pane of qsa(this.root, ".kc-pane")) this.reveal(pane);
  }

  /* ------------------------------------------------------------ dock + view */

  setDock(tab: DockTab, animate = false): void {
    if (tab === "dashboard" && this.state.view === "dashboard") this.setView("code");
    this.state.dock = tab;
    this.root.dataset.dock = tab;
    const tabs = qsa(this.root, ".kc-dock__tab");
    for (const t of tabs) {
      const on = t.dataset.kcTab === tab;
      if (t.tagName === "BUTTON") {
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
      } else if (on) t.dataset.selected = "true";
      else t.removeAttribute("data-selected");
    }
    for (const panel of qsa(this.root, ".kc-dock__panel")) {
      panel.hidden = panel.dataset.kcPanel !== tab;
      if (!panel.hidden) this.materializePanel(panel);
    }
    for (const mt of qsa(this.root, "[data-kc-mtab^='dock:']")) mt.hidden = mt.dataset.kcMtab !== `dock:${tab}`;
    const dock = this.root.querySelector<HTMLElement>("[data-kc-dock]");
    if (dock && animate && tab !== "none") {
      dock.setAttribute("data-enter", "");
      window.setTimeout(() => dock.removeAttribute("data-enter"), 500);
    }
    this.pinLogs();
  }

  setView(view: Scene["view"]): void {
    this.state.view = view;
    this.root.dataset.view = view;
    const dash = this.root.querySelector("[data-kc-dash]");
    const home =
      view === "dashboard"
        ? this.root.querySelector("[data-kc-dashview]")
        : this.root.querySelector("[data-kc-dash-home]");
    if (dash && home && dash.parentElement !== home) home.append(dash);
    if (view === "dashboard" && this.state.dock === "dashboard") this.setDock("browser");
    for (const el of qsa(this.root, ".kc-rail__item[data-kc-action^='view:']")) {
      const on = el.dataset.kcAction === `view:${view}`;
      if (on) el.dataset.current = "true";
      else el.removeAttribute("data-current");
      if (el.tagName === "BUTTON") {
        if (on) el.setAttribute("aria-current", "page");
        else el.removeAttribute("aria-current");
      }
    }
  }

  private toast(): void {
    const toast = this.root.querySelector<HTMLElement>("[data-kc-toast]");
    if (!toast) return;
    this.sched.after(900, () => {
      toast.setAttribute("data-show", "");
      this.sched.after(2600, () => toast.removeAttribute("data-show"));
    });
  }

  /* ------------------------------------------------------------ status + summary */

  private paintStatus(el: HTMLElement, status: ThreadStatus, animate: boolean): void {
    if (el.dataset.status === status) return;
    const meta = STATUS[status];
    el.dataset.status = status;
    el.dataset.tone = meta.tone;
    const icon = el.querySelector<HTMLElement>(".kc-status__icon");
    if (icon) icon.dataset.i = meta.icon;
    const text = el.querySelector(".kc-status__text");
    if (text) text.textContent = meta.label;
    if (animate && !reducedMotion()) {
      el.setAttribute("data-changed", "");
      window.setTimeout(() => el.removeAttribute("data-changed"), 1400);
    }
  }

  private refreshStatuses(animate: boolean): void {
    const approval = this.state.approval;
    for (const source of this.threadSources()) {
      const by = source.dataset.statusBy;
      if (!by) continue;
      const map = Object.fromEntries(by.split(" ").map((pair) => pair.split(":") as [string, string]));
      const status = map[approval] as ThreadStatus | undefined;
      const id = source.dataset.thread ?? source.dataset.kcPaneTpl;
      if (!status || !id) continue;
      for (const el of qsa(this.root, `[data-kc-status-for="${id}"]`)) this.paintStatus(el, status, animate);
    }
    for (const el of qsa(this.root, "[data-activity-by]")) {
      try {
        const map = JSON.parse(el.dataset.activityBy ?? "{}") as Record<string, string>;
        el.textContent = map[approval] ?? el.dataset.activity ?? el.textContent;
      } catch {
        /* keep the rendered text */
      }
    }
    this.refreshSummary();
  }

  private refreshSummary(): void {
    const dash = this.root.querySelector("[data-kc-dash]");
    if (!dash) return;
    const statuses = qsa(dash, ".kc-row:not([hidden]) .kc-status").map((el) => el.dataset.status as ThreadStatus);
    const pending = new Set(qsa(dash, ".kc-approval[data-state='pending']").map((c) => c.dataset.approvalId)).size;
    const s = summarize(statuses, pending);
    for (const el of qsa(this.root, "[data-kc-count]")) {
      const key = el.dataset.kcCount as keyof typeof s;
      if (key in s) el.textContent = String(s[key]);
    }
    const label = this.root.querySelector("[data-kc-count-label='approvals']");
    if (label) label.textContent = s.approvals === 1 ? "Needs approval" : "Need approval";
    const lead = this.root.querySelector("[data-kc-dash-lead]");
    if (lead) lead.textContent = summaryLead(s);
    const total = Math.max(1, s.working + s.approvals + s.reply + s.idle);
    const pct = (n: number) => ((n / total) * 100).toFixed(2);
    const segs: [string, number, number][] = [
      ["working", 0, s.working],
      ["attention", s.working, s.approvals + s.reply],
      ["idle", s.working + s.approvals + s.reply, s.idle],
    ];
    for (const [key, x, w] of segs) {
      const rect = this.root.querySelector(`[data-seg="${key}"]`);
      rect?.setAttribute("x", pct(x));
      rect?.setAttribute("width", pct(w));
    }
  }

  /* ------------------------------------------------------------ approvals + modes */

  setApproval(state: ApprovalState, options: { animate?: boolean } = {}): void {
    const animate = Boolean(options.animate) && !reducedMotion();
    this.state.approval = state;
    this.root.dataset.approval = state;
    for (const el of qsa(this.root, "[data-when]")) el.hidden = !(el.dataset.when ?? "").split(" ").includes(state);
    this.paintApprovalCards(animate);
    this.refreshStatuses(animate);
    this.pinLogs();
  }

  private paintApprovalCards(animate: boolean): void {
    const outcome = ZOD_APPROVAL.byMode[this.state.mode];
    for (const card of qsa(this.root, ".kc-approval[data-approval-id='zod']")) {
      const inPerms = Boolean(card.closest("[data-kc-perms]"));
      const next =
        inPerms && outcome !== "ask"
          ? `mode-${outcome}`
          : inPerms && this.state.approval === "none"
            ? "pending"
            : this.state.approval;
      const arrived = next === "pending" && card.dataset.state !== "pending";
      card.dataset.state = next;
      if (arrived && animate) {
        card.setAttribute("data-arrived", "");
        window.setTimeout(() => card.removeAttribute("data-arrived"), 1200);
      }
      const modeLabel = card.querySelector("[data-kc-mode-label]");
      if (modeLabel && inPerms) modeLabel.textContent = MODES.find((m) => m.id === this.state.mode)?.label ?? "Approve";
      const reason = card.querySelector("[data-kc-reason]");
      if (reason && inPerms) {
        const label = MODES.find((m) => m.id === this.state.mode)?.label ?? "Approve";
        reason.textContent =
          outcome === "ask"
            ? `${label} mode asks before installing packages.`
            : outcome === "allow"
              ? `${label} mode allows local installs.`
              : `${label} mode denies package installs.`;
      }
    }
  }

  decide(decision: Exclude<ApprovalState, "none" | "pending">, card?: HTMLElement | null): void {
    for (const c of qsa(this.root, ".kc-dash .kc-approval[data-approval-id='zod']")) {
      c.setAttribute("data-just", "");
      window.setTimeout(() => c.removeAttribute("data-just"), 2600);
    }
    this.setApproval(decision, { animate: true });
    const text = ZOD_APPROVAL.results[decision];
    this.say(text);
    const reset = card?.querySelector<HTMLElement>("[data-kc-action='approval:reset']");
    if (reset) reset.focus();
    else card?.querySelector<HTMLElement>("[data-kc-result]")?.focus();
    this.emit();
  }

  /** The Push request (always-ask scope): only Deny and Approve once, and it stays independent. */
  private decidePush(decision: Exclude<ApprovalState, "none" | "pending">, card: HTMLElement): void {
    card.dataset.state = decision;
    const text = card.querySelector(`[data-for="${decision}"]`)?.textContent ?? "";
    this.say(text);
    card.querySelector<HTMLElement>("[data-kc-result]")?.focus();
  }

  setMode(mode: PermissionMode, preview = false): void {
    if (!preview) this.state.mode = mode;
    this.root.dataset.mode = this.state.mode;
    for (const perms of qsa(this.root, "[data-kc-perms]")) {
      perms.dataset.mode = mode;
      for (const radio of qsa(perms, "[data-kc-mode]")) {
        const on = radio.dataset.kcMode === this.state.mode;
        if (radio.tagName === "BUTTON") {
          radio.setAttribute("aria-checked", on ? "true" : "false");
          radio.tabIndex = on ? 0 : -1;
        } else if (on) radio.dataset.checked = "true";
        else radio.removeAttribute("data-checked");
      }
    }
    const saved = this.state.mode;
    this.state.mode = mode;
    this.paintApprovalCards(false);
    this.state.mode = saved;
  }

  /* ------------------------------------------------------------ KalVoice */

  private voicePanel(): HTMLElement | null {
    return this.root.querySelector<HTMLElement>("[data-kc-voice]");
  }

  /**
   * The widget: compact (orb, KALVOICE, status) unless `expanded`, which briefly shows the live
   * transcript, a short result with "Type it instead", an approval or an error.
   */
  private setVoice(state: VoiceState, options: { text?: string; result?: string; expanded?: boolean } = {}): void {
    this.state.voice = state;
    this.root.dataset.voice = state;
    const panel = this.voicePanel();
    if (!panel) return;
    panel.dataset.state = state;
    panel.dataset.expanded = String(options.expanded ?? state !== "off");
    const label = panel.querySelector("[data-kc-voice-label]");
    if (label) label.textContent = VOICE_LABEL[state];
    const t = panel.querySelector("[data-kc-voice-text]");
    if (t && options.text !== undefined) t.textContent = options.text;
    const r = panel.querySelector("[data-kc-voice-result]");
    if (r)
      r.textContent =
        options.result ??
        (state === "spawned"
          ? VOICE.spawnedResult
          : `Typed into ${PROVIDER_NAME[this.providerOf(this.voiceTarget())]}`);
    if (state === "done" && options.text === undefined) this.typeInto(this.voiceTarget(), VOICE.dictation, false);
  }

  /** Collapse back to compact after a moment, then return to Ready. */
  private collapseVoice(afterMs: number): void {
    this.sched.after(afterMs, () => {
      const panel = this.voicePanel();
      if (panel) panel.dataset.expanded = "false";
      this.sched.after(1600, () => this.setVoice("off", { expanded: false }));
    });
  }

  private voiceTarget(): string {
    const focus = this.state.focus;
    if (focus && this.providerOf(focus) !== "shell" && this.state.panes.includes(focus)) return focus;
    return this.state.panes.find((id) => this.providerOf(id) !== "shell") ?? DEFAULT_THREAD.claude;
  }

  private resetInputs(): void {
    for (const input of qsa(this.root, "[data-kc-input][data-typed]")) {
      input.removeAttribute("data-typed");
      input.textContent = input.dataset.placeholder ?? "";
    }
  }

  private typeInto(threadId: string, text: string, animate: boolean): void {
    const input = this.pane(threadId)?.querySelector<HTMLElement>("[data-kc-input]");
    if (!input) return;
    input.setAttribute("data-typed", "");
    if (!animate || reducedMotion()) {
      input.textContent = text;
      return;
    }
    input.textContent = "";
    let i = 0;
    const step = () => {
      i = Math.min(text.length, i + 2);
      input.textContent = text.slice(0, i);
      if (i < text.length) this.sched.after(36, step);
    };
    step();
  }

  /** The live transcript: words appear as they are recognised. */
  private liveWords(text: string, perWord: number): void {
    const t = this.voicePanel()?.querySelector("[data-kc-voice-text]");
    if (!t) return;
    const words = text.split(" ");
    let n = 0;
    t.textContent = "";
    const step = () => {
      n += 1;
      t.textContent = words.slice(0, n).join(" ");
      if (n < words.length && this.state.voice === "listening") this.sched.after(perWord, step);
    };
    this.sched.after(260, step);
  }

  private startWave(loop: boolean, durationMs: number): void {
    this.stopWave();
    const bars = qsa(this.root, "[data-kc-wave] .kc-wave__bar");
    const orb = this.root.querySelector<HTMLElement>("[data-kc-orb]");
    if (!bars.length || reducedMotion()) return;
    const amps = VOICE.amplitudes;
    const start = performance.now();
    const frame = (now: number) => {
      const t = now - start;
      if (!loop && t > durationMs) return;
      if (!this.visible) {
        this.wave = requestAnimationFrame(frame);
        return;
      }
      const pos = t / 40;
      bars.forEach((bar, i) => {
        const a = amps[Math.floor(pos + i * 1.7) % amps.length] ?? 0.2;
        const b = amps[Math.floor(pos + i * 1.7 + 1) % amps.length] ?? a;
        const v = Math.max(0.1, a + (b - a) * (pos % 1));
        bar.style.transform = `scaleY(${v.toFixed(3)})`;
      });
      if (orb) orb.style.transform = `scale(${(1 + (amps[Math.floor(pos) % amps.length] ?? 0) * 0.06).toFixed(3)})`;
      this.wave = requestAnimationFrame(frame);
    };
    this.wave = requestAnimationFrame(frame);
  }

  private stopWave(): void {
    if (this.wave !== undefined) cancelAnimationFrame(this.wave);
    this.wave = undefined;
    for (const bar of qsa(this.root, "[data-kc-wave] .kc-wave__bar")) bar.style.removeProperty("transform");
    this.root.querySelector<HTMLElement>("[data-kc-orb]")?.style.removeProperty("transform");
  }

  get voiceBusy(): boolean {
    return this.state.voice === "listening" || this.state.voice === "processing" || this.state.voice === "executing";
  }

  private beginListening(say: "dictation" | "command"): string {
    // A new utterance supersedes whatever the widget was still finishing (collapse timers, typing).
    this.sched.cancel();
    this.stopWave();
    if (this.state.view === "dashboard") this.setView("code");
    const target = this.voiceTarget();
    if (!this.state.panes.includes(target)) this.open(target);
    this.setFocus(target);
    this.resetInputs();
    this.setVoice("listening", { text: "" });
    this.liveWords(say === "command" ? VOICE.command : VOICE.dictation, say === "command" ? 230 : 170);
    this.say(`KalVoice is listening. Release ${VOICE.key} to finish.`);
    return target;
  }

  /** Scripted dictation: hold, speak, release; the prompt types into the focused pane. */
  dictate(): void {
    if (this.voiceBusy) return;
    if (reducedMotion()) {
      const target = this.voiceTarget();
      this.setVoice("done", { text: VOICE.dictation });
      this.typeInto(target, VOICE.dictation, false);
      this.say(`KalVoice typed “${VOICE.dictation}” into ${PROVIDER_NAME[this.providerOf(target)]}.`);
      this.emit();
      return;
    }
    const target = this.beginListening("dictation");
    this.startWave(false, 2000);
    this.sched.after(2000, () => this.finishDictation(target));
    this.emit();
  }

  /** Push-to-talk: listening while the key is held (at least 0.8 s), then the action on release. */
  holdStart(say: "dictation" | "command" = "dictation"): void {
    if (this.voiceBusy) return;
    this.hold = { start: performance.now(), released: false, say };
    this.beginListening(say);
    this.startWave(true, 0);
    this.emit();
  }

  holdEnd(): void {
    if (!this.hold || this.hold.released) return;
    this.hold.released = true;
    const say = this.hold.say;
    const minimum = say === "command" ? 1300 : 1900;
    const wait = Math.max(0, minimum - (performance.now() - this.hold.start));
    const target = this.voiceTarget();
    this.sched.after(wait, () => {
      this.hold = null;
      if (say === "command") this.recognise();
      else this.finishDictation(target);
    });
  }

  private finishDictation(target: string): void {
    this.stopWave();
    const t = this.voicePanel()?.querySelector("[data-kc-voice-text]");
    if (t) t.textContent = VOICE.dictation;
    this.setVoice("processing");
    this.sched.after(600, () => {
      this.setVoice("done", { text: VOICE.dictation, result: `Typed into ${PROVIDER_NAME[this.providerOf(target)]}` });
      this.typeInto(target, VOICE.dictation, true);
      this.say(`KalVoice typed “${VOICE.dictation}” into ${PROVIDER_NAME[this.providerOf(target)]}.`);
      this.collapseVoice(2400);
      this.emit();
    });
  }

  /** Scripted command: hold, say "Open two more agents", release; two threads open. */
  command(): void {
    if (this.voiceBusy) return;
    if (reducedMotion()) {
      this.setVoice("spawned", { text: VOICE.command });
      this.spawn(false);
      return;
    }
    this.beginListening("command");
    this.startWave(false, 1400);
    this.sched.after(1400, () => this.recognise());
    this.emit();
  }

  /** After release: process, recognise the command, execute it, show the short result. */
  private recognise(): void {
    this.stopWave();
    const t = this.voicePanel()?.querySelector("[data-kc-voice-text]");
    if (t) t.textContent = VOICE.command;
    this.setVoice("processing");
    this.sched.after(500, () => {
      this.setVoice("executing");
      this.say(`Command recognised: ${VOICE.command}.`);
      this.sched.after(600, () => {
        this.setVoice("spawned", { text: VOICE.command });
        this.spawn(true);
      });
    });
  }

  /** "Type it instead": undo the command's threads and type the words into the focused pane. */
  typeInstead(): void {
    const spawned = this.lastSpawn;
    this.lastSpawn = [];
    this.sched.cancel();
    const panes = this.state.panes.filter((id) => !spawned.includes(id));
    for (const id of spawned) {
      if (id.startsWith("new-")) {
        for (const el of qsa(this.root, "[data-kc-created]")) {
          const d = el.dataset;
          if (d.thread === id || d.kcRow === id || d.kcRailThread === id || d.kcMtab === id) el.remove();
        }
      } else this.setPresent(id, false);
    }
    this.setPanes(panes.length ? panes : [DEFAULT_THREAD.claude], false);
    const target = this.voiceTarget();
    this.setFocus(target);
    this.refreshSummary();
    this.setVoice("done", { text: VOICE.command, result: `Typed into ${PROVIDER_NAME[this.providerOf(target)]}` });
    this.typeInto(target, VOICE.command, true);
    this.pane(target)?.querySelector<HTMLElement>(".kc-pane__title")?.focus();
    this.say(
      `Typed “${VOICE.command}” into ${PROVIDER_NAME[this.providerOf(target)]} instead. The two threads were not opened.`,
    );
    this.collapseVoice(2400);
    this.pinLogs();
    this.emit();
  }

  private spawn(animate: boolean): void {
    const opened: string[] = [];
    for (const id of VOICE.spawns) {
      if (!this.present.has(id) || !this.state.panes.includes(id)) {
        this.setPresent(id, true);
        opened.push(id);
      } else {
        const fresh = this.newThread(id.startsWith("codex") ? "gemini" : "claude");
        if (fresh) opened.push(fresh);
      }
    }
    this.lastSpawn = opened;
    for (const id of opened) if (!this.state.panes.includes(id)) this.open(id, { animate, reveal: animate });
    const first = opened[0];
    if (first) this.setFocus(first);
    this.refreshSummary();
    const names = opened.map(
      (id) =>
        `${PROVIDER_NAME[this.providerOf(id)]}: ${this.pane(id)?.querySelector("[data-kc-name]")?.textContent?.replace(/^·\s*/, "") ?? "New thread"}`,
    );
    this.say(`${VOICE.spawnedResult}. ${names.join(". ")}. Type it instead undoes this and types the words.`);
    if (animate) this.collapseVoice(6000);
    this.emit();
  }

  /* ------------------------------------------------------------ mission (planned) */

  setMission(stage: number): void {
    this.state.mission = stage;
    this.root.dataset.mission = String(stage);
    for (const strip of qsa(this.root, "[data-kc-mission]")) {
      strip.dataset.stage = String(stage);
      for (const node of qsa(strip, ".kc-node")) {
        const i = Number(node.dataset.node ?? 0);
        node.dataset.state = stage === 5 || stage > i ? "done" : stage === i ? "active" : "waiting";
      }
    }
  }

  runMission(): void {
    if (reducedMotion()) {
      this.setMission(5);
      return;
    }
    let stage = 1;
    const step = () => {
      this.setMission(stage);
      if (stage === 5) {
        this.say(`Mission verified: ${MISSION.checks.length} checks passed.`);
        return;
      }
      stage += 1;
      this.sched.after(stage === 5 ? 900 : 750, step);
    };
    step();
  }

  /* ------------------------------------------------------------ events (interactive windows) */

  private bindEvents(): void {
    const root = this.root;
    root.addEventListener("click", (event) => {
      const el = (event.target as HTMLElement).closest<HTMLElement>("button");
      if (!el || !root.contains(el)) return;
      const decide = el.dataset.kcDecide as Exclude<ApprovalState, "none" | "pending"> | undefined;
      if (decide) {
        const card = el.closest<HTMLElement>(".kc-approval");
        if (card?.dataset.approvalId === "push") this.decidePush(decide, card);
        else this.decide(decide, card);
        return;
      }
      if (el.dataset.kcTab) {
        this.setDock(el.dataset.kcTab as DockTab, true);
        this.emit();
        return;
      }
      if (el.dataset.kcMtab) {
        this.selectMobileTab(el.dataset.kcMtab);
        return;
      }
      if (el.dataset.kcMode) {
        this.setMode(el.dataset.kcMode as PermissionMode);
        this.say(`${MODES.find((m) => m.id === el.dataset.kcMode)?.label} mode selected.`);
        this.emit();
        return;
      }
      const action = el.dataset.kcAction;
      if (!action) return;
      if (action === "focus" && el.dataset.thread)
        this.focusThread(el.dataset.thread, !el.classList.contains("kc-pane__title"));
      else if (action === "close" && el.dataset.thread) this.close(el.dataset.thread);
      else if (action === "split") this.split();
      else if (action === "view:dashboard" || action === "view:code") {
        this.setView(action === "view:dashboard" ? "dashboard" : "code");
        this.say(action === "view:dashboard" ? "Dashboard view." : "Code view.");
        this.emit();
      } else if (action === "voice:dictate") this.dictate();
      else if (action === "voice:type-instead") this.typeInstead();
      else if (action === "dock:none") {
        this.setDock("none");
        this.say("Dock closed.");
        this.emit();
      } else if (action === "approval:reset") {
        this.setApproval("pending", { animate: true });
        root.querySelector<HTMLElement>(".kc-approval:not([data-state='none']) [data-kc-decide='approved']")?.focus();
        this.say("Codex asks again: pnpm add zod.");
        this.emit();
      }
    });

    // Hover previews a permission mode; leaving restores the selection.
    root.addEventListener("pointerover", (event) => {
      const radio = (event.target as HTMLElement).closest<HTMLElement>("[data-kc-mode]");
      if (radio?.dataset.kcMode) this.previewMode(radio.dataset.kcMode as PermissionMode);
    });
    root.addEventListener("pointerout", (event) => {
      const radio = (event.target as HTMLElement).closest<HTMLElement>("[data-kc-mode]");
      const to = (event.relatedTarget as HTMLElement | null)?.closest?.("[data-kc-mode]");
      if (radio && !to) this.previewMode(null);
    });

    // Like the app, approvals bind no single-key shortcuts: answers are buttons only.

    for (const list of qsa(root, ".kc-dock__tabs"))
      roving(list, ".kc-dock__tab", { select: (el) => this.setDock(el.dataset.kcTab as DockTab, true) });
    for (const list of qsa(root, "[data-kc-mtabs]"))
      roving(list, ".kc-mtab", { select: (el) => this.selectMobileTab(el.dataset.kcMtab ?? "") });
    for (const group of qsa(root, ".kc-perms__modes")) {
      roving(group, ".kc-mode", {
        orientation: "both",
        select: (el) => {
          this.setMode(el.dataset.kcMode as PermissionMode);
          this.say(`${MODES.find((m) => m.id === el.dataset.kcMode)?.label} mode selected.`);
        },
      });
    }

    // Phones: swiping between panes (scroll snap) updates the tabs and the focused pane.
    const main = root.querySelector<HTMLElement>("[data-kc-main]");
    if (main && "IntersectionObserver" in window) {
      const io = new IntersectionObserver(
        (entries) => {
          if (!this.isPhoneLayout()) return;
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const el = e.target as HTMLElement;
            if (el.matches(".kc-pane")) {
              this.mobileKey = undefined;
              this.setFocus(el.dataset.thread ?? "");
            } else if (el.matches("[data-kc-dock]")) {
              this.mobileKey = `dock:${this.state.dock}`;
              this.syncMobileTabs();
            }
          }
        },
        { root: main, threshold: 0.6 },
      );
      const observe = () => {
        for (const el of qsa(root, ".kc-grid > .kc-pane, [data-kc-dock]")) io.observe(el);
      };
      observe();
      root.addEventListener("kc:state", observe);
    }
  }

  /**
   * Hover previews a mode in the hint and the Allow / Ask / Deny column only. The approval card
   * follows the selection, not the pointer, so a preview never changes the layout under it.
   */
  private previewMode(mode: PermissionMode | null): void {
    for (const perms of qsa(this.root, "[data-kc-perms]")) perms.dataset.mode = mode ?? this.state.mode;
  }

  private selectMobileTab(key: string): void {
    if (key.startsWith("dock:")) {
      this.mobileKey = key;
      this.syncMobileTabs();
      this.root
        .querySelector("[data-kc-dock]")
        ?.scrollIntoView({ block: "nearest", inline: "start", behavior: reducedMotion() ? "auto" : "smooth" });
      return;
    }
    this.mobileKey = undefined;
    this.setFocus(key, { scroll: true });
    this.emit();
  }

  /** Rail and Dashboard rows: open the thread's terminal and move keyboard focus into it. */
  focusThread(id: string, moveFocus: boolean): void {
    if (!this.pane(id)) return;
    const wasOpen = this.state.panes.includes(id);
    this.open(id, { animate: !wasOpen });
    if (moveFocus) this.pane(id)?.querySelector<HTMLElement>(".kc-pane__title")?.focus();
    const name = this.pane(id)?.querySelector("[data-kc-name]")?.textContent?.replace(/^·\s*/, "") ?? "";
    this.say(`${PROVIDER_NAME[this.providerOf(id)]}${name ? `, ${name}` : ""}: terminal focused.`);
  }
}

/* ------------------------------------------------------------ registry */

const apps = new WeakMap<HTMLElement, StageApp>();

export function getApp(root: HTMLElement): StageApp {
  let app = apps.get(root);
  if (!app) {
    app = new StageApp(root);
    apps.set(root, app);
  }
  return app;
}

/** Initialises every auto window when it nears the viewport. Safe to call more than once. */
export function initAutoApps(): void {
  for (const root of qsa(document, "[data-kc-app][data-kc-auto='true']")) {
    if (root.dataset.kcBound) continue;
    root.dataset.kcBound = "true";
    whenNear(root, () => {
      const app = getApp(root);
      const intro = root.dataset.kcIntro as Play | undefined;
      if (!intro || reducedMotion()) return;
      const io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io.disconnect();
          app.apply({}, { animate: true, play: intro });
        },
        { threshold: 0.35 },
      );
      io.observe(root);
    });
  }
}
