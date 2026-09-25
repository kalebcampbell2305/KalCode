/**
 * CommandCenterStage: a deterministic loop of agent status changes (the app's statuses), a live
 * summary, rolling terminal thumbnails, and a Codex approval the visitor can answer (the preview
 * answers Approve once itself after a pause). Hover or focus links an agent row and its terminal.
 * Paused offscreen or in a hidden tab; reduced motion keeps the static snapshot.
 */
import {
  type AgentBeat,
  COMMAND_CENTER,
  STATUS,
  summarize,
  summaryLead,
  type ThreadStatus,
  ZOD_APPROVAL,
} from "../../data/story";
import { paintStatus } from "./app";
import { announce, qsa, reducedMotion, Scheduler, watchVisibility, whenNear } from "./util";

type Decision = "approved" | "allowed" | "workspace" | "denied";

function wire(root: HTMLElement): void {
  root.dataset.kcWired = "true";
  const sched = new Scheduler();
  const live = root.querySelector("[data-kc-cc-live]");
  const card = root.querySelector<HTMLElement>(".kc-approval[data-approval-id='zod']");
  const statuses = new Map<string, ThreadStatus>();
  let visible = false;
  let started = false;
  let waitingForDecision = false;

  /* ---------------------------------------------------------- painting */

  const setAgent = (beat: Omit<AgentBeat, "at">, animate: boolean) => {
    statuses.set(beat.agent, beat.status);
    for (const el of qsa(root, `[data-kc-status-for="${beat.agent}"]`)) paintStatus(el, beat.status, animate);
    const act = root.querySelector(`[data-kc-cc-activity="${beat.agent}"]`);
    if (act) act.textContent = beat.activity;
    const thumb = root.querySelector<HTMLElement>(`.kc-cc__thumb[data-agent="${beat.agent}"]`);
    if (thumb && beat.tail) {
      const l1 = thumb.querySelector<HTMLElement>("[data-kc-cc-line='1']");
      const l2 = thumb.querySelector<HTMLElement>("[data-kc-cc-line='2']");
      if (l1 && l2) {
        l1.textContent = l2.textContent;
        l2.textContent = beat.tail;
        if (animate && !reducedMotion()) {
          l2.removeAttribute("data-in");
          void l2.offsetWidth;
          l2.setAttribute("data-in", "");
        }
      }
    }
    if (animate) addEvent(beat.agent, beat.activity);
    const row = root.querySelector<HTMLElement>(`.kc-cc__row[data-agent="${beat.agent}"]`);
    if (row && animate && !reducedMotion()) {
      row.setAttribute("data-pulse", "");
      window.setTimeout(() => row.removeAttribute("data-pulse"), 900);
    }
    refresh();
  };

  const refresh = () => {
    const pending = card?.dataset.state === "pending" ? 1 : 0;
    const s = summarize([...statuses.values()], pending);
    const values: Record<string, number> = {
      working: s.working,
      waiting: s.approvals + s.reply,
      completed: COMMAND_CENTER.completedToday + [...statuses.values()].filter((v) => v === "completed").length,
      terminals: s.terminals,
    };
    for (const el of qsa(root, "[data-kc-count]")) {
      const v = values[el.dataset.kcCount ?? ""];
      if (v !== undefined && el.textContent !== String(v)) {
        el.textContent = String(v);
        if (started && !reducedMotion()) {
          el.removeAttribute("data-bump");
          void el.offsetWidth;
          el.setAttribute("data-bump", "");
        }
      }
    }
    const lead = root.querySelector("[data-kc-dash-lead]");
    if (lead) lead.textContent = summaryLead(s);
    root.dataset.queue = pending ? "pending" : card?.dataset.state === "none" ? "empty" : "decided";
  };

  /** Recent activity: newest first, five items. */
  const addEvent = (agent: string, activity: string) => {
    const list = root.querySelector("[data-kc-cc-feed]");
    const source = list?.querySelector<HTMLElement>(`.kc-cc__event[data-agent="${agent}"]`);
    if (!list || !source) return;
    const item = source.cloneNode(true) as HTMLElement;
    const text = item.querySelector(".kc-cc__etext");
    const name = text?.querySelector("b")?.textContent ?? "";
    if (text) {
      text.textContent = "";
      const b = document.createElement("b");
      b.textContent = name;
      text.append(b, ` ${activity.charAt(0).toLowerCase()}${activity.slice(1)}`);
    }
    const ago = item.querySelector(".kc-cc__eago");
    if (ago) ago.textContent = "now";
    for (const old of qsa(list, ".kc-cc__eago")) if (old.textContent === "now") old.textContent = "1 min";
    item.setAttribute("data-in", "");
    list.prepend(item);
    while (list.children.length > 5) list.lastElementChild?.remove();
  };

  /* ---------------------------------------------------------- approval */

  const ask = () => {
    if (!card) return;
    card.dataset.state = "pending";
    card.setAttribute("data-arrived", "");
    window.setTimeout(() => card.removeAttribute("data-arrived"), 1200);
    waitingForDecision = true;
    refresh();
    announce(live, `${ZOD_APPROVAL.notice}. Deny, Allow for workspace, Allow for thread or Approve once.`);
    sched.after(COMMAND_CENTER.autoApproveMs, () => {
      if (!waitingForDecision) return;
      const btn = card.querySelector<HTMLElement>("[data-kc-decide='approved']");
      btn?.classList.add("is-pressed");
      sched.after(260, () => {
        btn?.classList.remove("is-pressed");
        decide("approved", false);
      });
    });
  };

  const decide = (decision: Decision, fromVisitor: boolean) => {
    if (!card || !waitingForDecision) return;
    waitingForDecision = false;
    card.dataset.state = decision;
    refresh();
    announce(live, ZOD_APPROVAL.results[decision]);
    if (fromVisitor) card.querySelector<HTMLElement>("[data-kc-result]")?.focus();
    if (decision === "denied") {
      setAgent(
        {
          agent: "codex-signup",
          status: "waiting_for_user",
          activity: "Asked how to validate without zod",
          tail: "• No new packages. Validate by hand?",
        },
        true,
      );
    } else {
      for (const beat of COMMAND_CENTER.afterApproval) sched.after(beat.at, () => setAgent(beat, true));
    }
    sched.after(3200, () => {
      card.dataset.state = "none";
      refresh();
    });
  };

  card?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-kc-decide]");
    if (btn?.dataset.kcDecide) decide(btn.dataset.kcDecide as Decision, true);
  });

  /* ---------------------------------------------------------- loop */

  const start = () => {
    sched.cancel();
    waitingForDecision = false;
    if (card) card.dataset.state = "none";
    for (const [agent, s] of Object.entries(COMMAND_CENTER.start)) setAgent({ agent, ...s }, false);
    for (const beat of COMMAND_CENTER.beats) {
      sched.after(beat.at, () => {
        setAgent(beat, true);
        if (beat.approval === "ask") ask();
      });
    }
    const end = Math.max(COMMAND_CENTER.loopMs, ...COMMAND_CENTER.beats.map((b) => b.at + 3000));
    sched.after(end, () => {
      // Wait for an open question to be answered before starting over.
      if (waitingForDecision) sched.after(COMMAND_CENTER.autoApproveMs + 4000, start);
      else start();
    });
  };

  /* ---------------------------------------------------------- linking rows and terminals */

  let pinned: string | null = null;
  const hot = (agent: string | null) => {
    const target = agent ?? pinned;
    if (target) root.dataset.hot = target;
    else root.removeAttribute("data-hot");
    for (const el of qsa(root, "[data-agent]")) {
      if (el.dataset.agent === target) el.setAttribute("data-hot", "");
      else el.removeAttribute("data-hot");
    }
  };
  root.addEventListener("pointerover", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".kc-cc__row, .kc-cc__thumb");
    hot(el?.dataset.agent ?? null);
  });
  root.addEventListener("pointerleave", () => hot(null));
  root.addEventListener("focusin", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".kc-cc__row");
    if (el) hot(el.dataset.agent ?? null);
  });
  root.addEventListener("focusout", (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) hot(null);
  });
  root.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-kc-cc-agent]");
    if (!btn) return;
    const agent = btn.dataset.kcCcAgent ?? null;
    pinned = pinned === agent ? null : agent;
    for (const b of qsa(root, "[data-kc-cc-agent]"))
      b.setAttribute("aria-pressed", b.dataset.kcCcAgent === pinned ? "true" : "false");
    hot(null);
    const name = btn.querySelector(".kc-cc__rname")?.textContent ?? "";
    const status = STATUS[statuses.get(agent ?? "") ?? "idle"].label;
    announce(live, pinned ? `${name}: ${status}. Its terminal is highlighted.` : "Highlight cleared.");
  });

  /* ---------------------------------------------------------- lifecycle */

  // Record the snapshot's statuses so counts are right even before the loop starts.
  for (const el of qsa(root, ".kc-cc__row")) {
    const s = el.querySelector<HTMLElement>(".kc-status")?.dataset.status as ThreadStatus | undefined;
    if (el.dataset.agent && s) statuses.set(el.dataset.agent, s);
  }
  if (card) card.dataset.state = statuses.get("codex-signup") === "waiting_for_permission" ? "pending" : "none";
  refresh();
  if (reducedMotion()) return;

  watchVisibility(root, (v) => {
    visible = v;
    if (!visible) {
      sched.pause();
      root.setAttribute("data-paused", "true");
      return;
    }
    root.removeAttribute("data-paused");
    if (!started) {
      started = true;
      start();
    } else sched.resume();
  });
}

for (const root of qsa(document, "[data-kc-cc]")) whenNear(root, () => wire(root));
